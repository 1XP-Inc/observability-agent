import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { OAConfig } from "./config";
import { Semaphore } from "./semaphore";
import type { BundleArtifact, BundleJob } from "./types";
import { HttpError } from "./http-error";
import { isoNow } from "./util";

export type RunFn<P> = (job: BundleJob<P>) => Promise<void>;

export type BundleManager<P = unknown> = {
  create: (params: P) => Promise<BundleJob<P>>;
  get: (bundleId: string) => BundleJob<P> | undefined;
  getArtifact: (bundleId: string) => BundleArtifact | undefined;
  startCleanupLoop: () => void;
};

export function createBundleManager<P>(config: OAConfig, runFn: RunFn<P>): BundleManager<P> {
  const sem = new Semaphore(config.maxInflightBundles);
  const jobs = new Map<string, BundleJob<P>>();

  async function cleanupOnce(): Promise<void> {
    try {
      await fs.mkdir(config.bundleDir, { recursive: true, mode: 0o700 });
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

      // Drop expired job metadata (skip running jobs).
      for (const [id, job] of jobs.entries()) {
        if (job.status === "running" || job.status === "queued") continue;
        const exp = Date.parse(job.expiresAt);
        if (Number.isFinite(exp) && exp < Date.now()) {
          jobs.delete(id);
        }
      }
    } catch (err: any) {
      // Best-effort cleanup — log so persistent failures are visible.
      if (typeof console !== "undefined") console.warn("[oa] cleanup error:", err?.message);
    }
  }

  function startCleanupLoop(): void {
    void cleanupOnce();
    setInterval(() => void cleanupOnce(), config.cleanupIntervalMs).unref();
  }

  async function create(params: P): Promise<BundleJob<P>> {
    if (!sem.tryAcquire()) {
      throw new HttpError(429, "maxInflightBundles exceeded");
    }

    const bundleId = `bnd_${randomUUID().replace(/-/g, "")}`;
    const now = isoNow();
    const expiresAt = new Date(Date.now() + config.bundleTtlMs).toISOString();

    const job: BundleJob<P> = {
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
        await runFn(job);
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

  function get(bundleId: string): BundleJob<P> | undefined {
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
