import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import type { OAConfig } from "../config";
import type { BundleManager } from "../bundle-manager";
import { HttpError } from "../http-error";
import { loadSkillMarkdown } from "../skill";
import type { ServiceDef, StandaloneNormalizedRequest } from "./types";
import { normalizeStandaloneBundleRequest } from "./validate";

function hasString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
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

  app.get("/v1/services", async (_req, reply) => {
    const items = services.map((s) => ({
      name: s.name,
      logs: s.logs ?? [],
      journal: s.journal ?? null,
      metrics: s.metrics ?? null,
    }));
    reply.send({ items });
  });

  app.post("/v1/bundles", async (req, reply) => {
    try {
      const normalized = normalizeStandaloneBundleRequest(req.body, config, services);
      const job = await bundles.create(normalized);
      reply.send({ bundleId: job.bundleId, status: job.status });
    } catch (err: any) {
      if (err instanceof HttpError) {
        reply.code(err.statusCode).send({ error: err.message, details: err.details });
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
    if (job.status !== "done" || !job.artifactPath) {
      reply.code(409).send({ error: "bundle_not_ready" });
      return;
    }
    if (!fs.existsSync(job.artifactPath)) {
      reply.code(410).send({ error: "bundle_artifact_gone" });
      return;
    }

    const stat = fs.statSync(job.artifactPath);

    reply.header("Content-Type", "application/gzip");
    reply.header("Content-Disposition", `attachment; filename="${bundleId}.ndjson.gz"`);
    reply.header("Content-Length", String(stat.size));
    reply.header("Cache-Control", "no-store");

    return reply.send(fs.createReadStream(job.artifactPath));
  });
}
