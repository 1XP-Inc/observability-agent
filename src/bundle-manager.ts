import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { CoreV1Api } from "@kubernetes/client-node";
import type { OAConfig } from "./config";
import { Semaphore } from "./semaphore";
import type { BundleArtifact, BundleJob, NormalizedBundleRequest } from "./types";
import { HttpError } from "./validate";
import { runBundle } from "./bundle-runner";
import { isoNow } from "./util";

export type BundleManager = {
  create: (params: NormalizedBundleRequest) => Promise<BundleJob>;
  get: (bundleId: string) => BundleJob | undefined;
  getArtifact: (bundleId: string) => BundleArtifact | undefined;
  startCleanupLoop: () => void;
};

export function createBundleManager(config: OAConfig, coreV1: CoreV1Api): BundleManager {
  const sem = new Semaphore(config.maxInflightBundles);
  const jobs = new Map<string, BundleJob>();

  async function cleanupOnce(): Promise<void> {
    try {
      await fs.mkdir(config.bundleDir, { recursive: true });
      const entries = await fs.readdir(config.bundleDir, { withFileTypes: true });
      const cutoff = Date.now() - config.bundleTtlMs;

      for (const ent of entries) {
        if (!ent.isFile()) continue;
        if (!ent.name.endsWith(".ndjson.gz")) continue;
        const p = path.join(config.bundleDir, ent.name);
        const st = await fs.stat(p);
        if (st.mtimeMs < cutoff) {
          await fs.rm(p, { force: true });
        }
      }

      // Drop expired job metadata.
      for (const [id, job] of jobs.entries()) {
        const exp = Date.parse(job.expiresAt);
        if (Number.isFinite(exp) && exp < Date.now()) {
          jobs.delete(id);
        }
      }
    } catch {
      // Best-effort cleanup.
    }
  }

  function startCleanupLoop(): void {
    void cleanupOnce();
    setInterval(() => void cleanupOnce(), config.cleanupIntervalMs).unref();
  }

  async function create(params: NormalizedBundleRequest): Promise<BundleJob> {
    if (!sem.tryAcquire()) {
      throw new HttpError(429, "maxInflightBundles exceeded");
    }

    const bundleId = `bnd_${randomUUID().replace(/-/g, "")}`;
    const now = isoNow();
    const expiresAt = new Date(Date.now() + config.bundleTtlMs).toISOString();

    const job: BundleJob = {
      bundleId,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      expiresAt,
      params,
    };
    jobs.set(bundleId, job);

    void (async () => {
      job.status = "running";
      job.updatedAt = isoNow();
      try {
        await runBundle({ config, coreV1, job });
        job.status = "done";
        job.updatedAt = isoNow();
      } catch (err: any) {
        job.status = "failed";
        job.updatedAt = isoNow();
        job.error = err?.message ? String(err.message) : "bundle_failed";
      } finally {
        sem.release();
      }
    })();

    return job;
  }

  function get(bundleId: string): BundleJob | undefined {
    return jobs.get(bundleId);
  }

  function getArtifact(bundleId: string): BundleArtifact | undefined {
    const job = jobs.get(bundleId);
    if (!job || job.status !== "done" || !job.artifactSizeBytes) return undefined;
    return {
      filename: `${bundleId}.ndjson.gz`,
      contentType: "application/gzip",
      sizeBytes: job.artifactSizeBytes,
      expiresAt: job.expiresAt,
      downloadPath: `/v1/bundles/${bundleId}/download`,
    };
  }

  return { create, get, getArtifact, startCleanupLoop };
}
