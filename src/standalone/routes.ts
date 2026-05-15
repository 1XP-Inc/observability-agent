import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { OAConfig } from "../config";
import type { BundleManager } from "../bundle-manager";
import { HttpError } from "../http-error";
import { loadSkillMarkdown } from "../skill";
import type { ServiceDef, StandaloneNormalizedRequest } from "./types";
import { normalizeStandaloneBundleRequest } from "./validate";
import {
  assertCapabilities,
  assertServicesAllowed,
  isServiceAllowed,
  principalFromRequest,
  type Capability,
  type Principal,
} from "../authorization";

function hasString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function sendHttpError(reply: any, err: HttpError): void {
  reply.code(err.statusCode).send({ error: err.message, details: err.details });
}

function bundleCapabilities(params: StandaloneNormalizedRequest): Capability[] {
  const capabilities: Capability[] = [];
  if (params.include.logs.enabled) capabilities.push("logs");
  if (params.include.metrics.enabled) capabilities.push("metrics");
  return capabilities;
}

function targetServiceNames(params: StandaloneNormalizedRequest, services: ServiceDef[]): string[] {
  return params.target.kind === "all" ? services.map((s) => s.name) : params.target.services;
}

function authorizeBundle(principal: Principal, params: StandaloneNormalizedRequest, services: ServiceDef[]): void {
  if (principal.admin) return;
  assertCapabilities(principal, bundleCapabilities(params));
  assertServicesAllowed(principal, targetServiceNames(params, services));
}

export function registerStandaloneRoutes(
  app: FastifyInstance,
  deps: {
    config: OAConfig;
    services: ServiceDef[];
    bundles: BundleManager<StandaloneNormalizedRequest>;
  },
): void {
  const { config, services, bundles } = deps;

  app.get("/skill.md", async (_req, reply) => {
    const md = loadSkillMarkdown();
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    reply.send(md);
  });

  app.get("/.well-known/skill.md", async (_req, reply) => {
    const md = loadSkillMarkdown();
    reply.header("Content-Type", "text/markdown; charset=utf-8");
    reply.send(md);
  });

  app.get("/v1/services", async (req, reply) => {
    const principal = principalFromRequest(req);
    const visibleServices = principal.admin ? services : services.filter((s) => isServiceAllowed(principal, s.name));
    const items = visibleServices.map((s) => {
      const item: Record<string, unknown> = { name: s.name };
      if (principal.admin) {
        item.logs = s.logs ?? [];
        item.journal = s.journal ?? null;
        if (s.journalScope) item.journalScope = s.journalScope;
        if (s.journalUser) item.journalUser = s.journalUser;
        item.metrics = s.metrics ?? null;
      }
      return item;
    });
    reply.send({ items });
  });

  app.post("/v1/bundles", async (req, reply) => {
    try {
      const normalized = normalizeStandaloneBundleRequest(req.body, config, services);
      authorizeBundle(principalFromRequest(req), normalized, services);
      const job = await bundles.create(normalized);
      reply.send({ bundleId: job.bundleId, status: job.status });
    } catch (err: any) {
      if (err instanceof HttpError) {
        sendHttpError(reply, err);
        return;
      }
      reply.code(500).send({ error: "internal_error" });
    }
  });

  app.get("/v1/bundles/:bundleId", async (req, reply) => {
    const bundleId = (req.params as any)?.bundleId;
    /* c8 ignore start -- Fastify :bundleId always provides a string */
    if (!hasString(bundleId)) {
      reply.code(400).send({ error: "bundleId_required" });
      return;
    }
    /* c8 ignore stop */
    const job = bundles.get(bundleId);
    if (!job) {
      reply.code(404).send({ error: "bundle_not_found" });
      return;
    }
    try {
      authorizeBundle(principalFromRequest(req), job.params, services);
    } catch (err: any) {
      if (err instanceof HttpError) {
        sendHttpError(reply, err);
        return;
      }
      throw err;
    }
    const artifact = bundles.getArtifact(bundleId);
    reply.send({
      bundleId: job.bundleId,
      status: job.status,
      artifact,
      error: job.error,
    });
  });

  app.get("/v1/bundles/:bundleId/download", async (req, reply) => {
    const bundleId = (req.params as any)?.bundleId;
    /* c8 ignore start -- Fastify :bundleId always provides a string */
    if (!hasString(bundleId)) {
      reply.code(400).send({ error: "bundleId_required" });
      return;
    }
    /* c8 ignore stop */

    const job = bundles.get(bundleId);
    if (!job) {
      reply.code(404).send({ error: "bundle_not_found" });
      return;
    }
    try {
      authorizeBundle(principalFromRequest(req), job.params, services);
    } catch (err: any) {
      if (err instanceof HttpError) {
        sendHttpError(reply, err);
        return;
      }
      throw err;
    }
    if (job.status !== "done" || !job.artifactPath) {
      reply.code(409).send({ error: "bundle_not_ready" });
      return;
    }
    let fileStat: { size: number };
    try {
      fileStat = await stat(job.artifactPath);
    } catch {
      reply.code(410).send({ error: "bundle_artifact_gone" });
      return;
    }

    reply.header("Content-Type", "application/gzip");
    reply.header("Content-Disposition", `attachment; filename="${bundleId}.ndjson.gz"`);
    reply.header("Content-Length", String(fileStat.size));
    reply.header("Cache-Control", "no-store");

    return reply.send(createReadStream(job.artifactPath));
  });
}
