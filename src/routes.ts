import fs from "node:fs";
import type { FastifyInstance } from "fastify";
import type { CoreV1Api } from "@kubernetes/client-node";
import type { OAConfig } from "./config";
import type { BundleManager } from "./bundle-manager";
import type { BundleRequest } from "./types";
import { normalizeBundleRequest, HttpError } from "./validate";
import { loadSkillMarkdown } from "./skill";
import { listPodsAllNamespaces, listPodsNamespaced } from "./k8s-compat";

function hasString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function registerRoutes(
  app: FastifyInstance,
  deps: { config: OAConfig; coreV1: CoreV1Api; bundles: BundleManager },
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
    const q = (req.query as any) ?? {};
    const ns = hasString(q.ns) ? q.ns.trim() : "*";
    const selector = hasString(q.selector) ? q.selector.trim() : undefined;
    const needle = hasString(q.q) ? q.q : undefined;

    const limit = 500;
    const body =
      ns === "*"
        ? await listPodsAllNamespaces({ coreV1, labelSelector: selector, limit })
        : await listPodsNamespaced({ coreV1, namespace: ns, labelSelector: selector, limit });

    const items = ((body.items ?? []) as any[]).filter((p: any) => {
      if (!needle) return true;
      return String(p?.metadata?.name ?? "").includes(needle);
    });

    const out = items.map((p: any) => {
      const cond = (p.status?.conditions ?? []) as any[];
      const ready = cond.some((c: any) => c.type === "Ready" && c.status === "True");
      return {
        namespace: p.metadata?.namespace,
        name: p.metadata?.name,
        podIP: p.status?.podIP,
        labels: p.metadata?.labels ?? {},
        annotations: p.metadata?.annotations ?? {},
        containers: (p.spec?.containers ?? []).map((c: any) => c.name),
        ready,
        nodeName: p.spec?.nodeName,
        phase: p.status?.phase,
      };
    });

    reply.send({ items: out });
  });

  app.post("/v1/bundles", async (req, reply) => {
    try {
      const normalized = normalizeBundleRequest(req.body as BundleRequest, config);
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
    if (!hasString(bundleId)) {
      reply.code(400).send({ error: "bundleId_required" });
      return;
    }
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
    if (!hasString(bundleId)) {
      reply.code(400).send({ error: "bundleId_required" });
      return;
    }

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
