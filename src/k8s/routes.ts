import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type { CoreV1Api } from "@kubernetes/client-node";
import type { OAConfig } from "../config";
import type { BundleManager } from "../bundle-manager";
import type { BundleRequest, NormalizedBundleRequest } from "./types";
import { normalizeBundleRequest } from "./validate";
import { HttpError } from "../http-error";
import { loadSkillMarkdown } from "../skill";
import { listPodsAllNamespaces, listPodsNamespaced } from "./compat";
import {
  assertCapabilities,
  assertNamespaceAllowed,
  assertNamespacesAllowed,
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

function bundleCapabilities(params: NormalizedBundleRequest): Capability[] {
  const capabilities: Capability[] = [];
  if (params.include.logs.enabled) capabilities.push("logs");
  if (params.include.events.enabled) capabilities.push("events");
  if (params.include.metrics.enabled) capabilities.push("metrics");
  return capabilities;
}

function authorizeBundle(principal: Principal, params: NormalizedBundleRequest): void {
  if (principal.admin) return;
  const capabilities = bundleCapabilities(params);
  if (params.target.kind === "selector") capabilities.push("pods");
  assertCapabilities(principal, capabilities);

  if (params.target.kind === "selector") {
    assertNamespaceAllowed(principal, params.target.namespace);
    return;
  }

  assertNamespacesAllowed(principal, params.target.pods.map((p) => p.namespace));
}

export function registerRoutes(
  app: FastifyInstance,
  deps: { config: OAConfig; coreV1: CoreV1Api; bundles: BundleManager<NormalizedBundleRequest> },
): void {
  const { config, coreV1, bundles } = deps;

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

  app.get("/v1/pods", async (req, reply) => {
    const principal = principalFromRequest(req);

    const q = (req.query as any) ?? {};
    const ns = hasString(q.ns) ? q.ns.trim() : "*";
    const selector = hasString(q.selector) ? q.selector.trim() : undefined;
    const needle = hasString(q.q) ? q.q : undefined;

    try {
      assertCapabilities(principal, ["pods"]);
      assertNamespaceAllowed(principal, ns);
    } catch (err: any) {
      if (err instanceof HttpError) {
        sendHttpError(reply, err);
        return;
      }
      throw err;
    }

    const limit = 500;
    const allItems: any[] = [];
    let continueToken: string | undefined;
    do {
      const body =
        ns === "*"
          ? await listPodsAllNamespaces({ coreV1, labelSelector: selector, limit, continueToken })
          : await listPodsNamespaced({ coreV1, namespace: ns, labelSelector: selector, limit, continueToken });
      allItems.push(...((body.items ?? []) as any[]));
      continueToken = hasString(body.metadata?._continue) ? body.metadata._continue : undefined;
    } while (continueToken);

    const items = allItems.filter((p: any) => {
      if (!needle) return true;
      return String(p?.metadata?.name ?? "").includes(needle);
    });

    const out = items.map((p: any) => {
      const cond = (p.status?.conditions ?? []) as any[];
      const ready = cond.some((c: any) => c.type === "Ready" && c.status === "True");
      const item: Record<string, unknown> = {
        namespace: p.metadata?.namespace,
        name: p.metadata?.name,
        labels: p.metadata?.labels ?? {},
        containers: (p.spec?.containers ?? []).map((c: any) => c.name),
        ready,
        phase: p.status?.phase,
      };
      if (principal.admin) {
        item.podIP = p.status?.podIP;
        item.annotations = p.metadata?.annotations ?? {};
        item.nodeName = p.spec?.nodeName;
      }
      return item;
    });

    reply.send({ items: out });
  });

  app.post("/v1/bundles", async (req, reply) => {
    try {
      const normalized = normalizeBundleRequest(req.body as BundleRequest, config);
      authorizeBundle(principalFromRequest(req), normalized);
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
      authorizeBundle(principalFromRequest(req), job.params);
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
      authorizeBundle(principalFromRequest(req), job.params);
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
