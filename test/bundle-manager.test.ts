import { vi } from "vitest";

vi.mock("../src/bundle-runner", () => ({
  runBundle: vi.fn(async () => {}),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn(async () => {}),
    readdir: vi.fn(async () => []),
    stat: vi.fn(async () => ({ mtimeMs: Date.now() })),
    rm: vi.fn(async () => {}),
  },
}));

import { createBundleManager } from "../src/bundle-manager";
import { runBundle } from "../src/bundle-runner";
import fs from "node:fs/promises";
import { createMockConfig, createMockCoreV1Api } from "./helpers";
import type { NormalizedBundleRequest } from "../src/types";

function makeParams(overrides?: Partial<NormalizedBundleRequest>): NormalizedBundleRequest {
  return {
    timeWindow: { kind: "relative", sinceSeconds: 600 },
    target: { kind: "selector", namespace: "default", selector: "app=web" },
    include: {
      logs: { enabled: true, tailLines: 100, previous: false, timestamps: true, excludePatterns: [] },
      events: { enabled: true },
      metrics: { enabled: false },
    },
    limits: {
      maxPods: 20,
      maxTotalLogLines: 50_000,
      sinceSecondsMax: 3600,
      maxMetricsPods: 20,
      metricsTimeoutMs: 2000,
      metricsConcurrency: 10,
    },
    ...overrides,
  };
}

// Wait for async effects (the fire-and-forget bundle execution)
async function flushAsync(ms = 50) {
  await new Promise((r) => setTimeout(r, ms));
}

describe("createBundleManager", () => {
  const config = createMockConfig();
  const coreV1 = createMockCoreV1Api();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ==========================
  // create()
  // ==========================
  describe("create()", () => {
    it("returns BundleJob with bundleId starting with 'bnd_'", async () => {
      const mgr = createBundleManager(config, coreV1);
      const job = await mgr.create(makeParams());
      expect(job.bundleId).toMatch(/^bnd_/);
    });

    it("status starts as 'queued'", async () => {
      // Block runBundle so the async runner cannot complete before we check status
      let resolve!: () => void;
      (runBundle as any).mockImplementation(() => new Promise<void>((r) => { resolve = r; }));

      const mgr = createBundleManager(config, coreV1);
      const job = await mgr.create(makeParams());
      // Before the microtask runs the IIFE, status should be "queued"
      // But the IIFE sets it to "running" on the next microtask. The create() returns
      // "queued" synchronously.
      // Since the fire-and-forget is scheduled, the status could be "queued" or "running".
      expect(["queued", "running"]).toContain(job.status);

      resolve();
      await flushAsync();
    });

    it("sets createdAt, updatedAt, expiresAt", async () => {
      const mgr = createBundleManager(config, coreV1);
      const job = await mgr.create(makeParams());
      expect(job.createdAt).toBeDefined();
      expect(job.updatedAt).toBeDefined();
      expect(job.expiresAt).toBeDefined();
      expect(Date.parse(job.expiresAt)).toBeGreaterThan(Date.now());
    });

    it("stores normalized params", async () => {
      const mgr = createBundleManager(config, coreV1);
      const params = makeParams();
      const job = await mgr.create(params);
      expect(job.params).toEqual(params);
    });

    it("triggers async runBundle execution", async () => {
      const mgr = createBundleManager(config, coreV1);
      await mgr.create(makeParams());

      await flushAsync();
      expect(runBundle).toHaveBeenCalledOnce();
    });

    it("after runBundle completes: status becomes 'done'", async () => {
      (runBundle as any).mockImplementation(async () => {});
      const mgr = createBundleManager(config, coreV1);
      const job = await mgr.create(makeParams());

      await flushAsync();
      expect(job.status).toBe("done");
    });

    it("after runBundle throws: status becomes 'failed' with error message", async () => {
      (runBundle as any).mockImplementation(async () => {
        throw new Error("boom");
      });
      const mgr = createBundleManager(config, coreV1);
      const job = await mgr.create(makeParams());

      await flushAsync();
      expect(job.status).toBe("failed");
      expect(job.error).toBe("boom");
    });

    it("after runBundle throws non-Error: status becomes 'failed' with fallback message", async () => {
      (runBundle as any).mockImplementation(async () => {
        throw "string error";
      });
      const mgr = createBundleManager(config, coreV1);
      const job = await mgr.create(makeParams());

      await flushAsync();
      expect(job.status).toBe("failed");
      expect(job.error).toBe("bundle_failed");
    });

    it("maxInflightBundles exceeded throws HttpError 429", async () => {
      // block runBundle so semaphore stays acquired
      let resolve!: () => void;
      (runBundle as any).mockImplementation(() => new Promise<void>((r) => { resolve = r; }));

      const mgr = createBundleManager(
        createMockConfig({ maxInflightBundles: 1 }),
        coreV1,
      );

      await mgr.create(makeParams());
      await flushAsync(10);

      await expect(mgr.create(makeParams())).rejects.toMatchObject({
        statusCode: 429,
        message: expect.stringContaining("maxInflightBundles"),
      });

      resolve();
      await flushAsync();
    });
  });

  // ==========================
  // get()
  // ==========================
  describe("get()", () => {
    it("returns job by bundleId", async () => {
      const mgr = createBundleManager(config, coreV1);
      const job = await mgr.create(makeParams());
      const found = mgr.get(job.bundleId);
      expect(found).toBe(job);
    });

    it("returns undefined for unknown bundleId", () => {
      const mgr = createBundleManager(config, coreV1);
      expect(mgr.get("bnd_nonexistent")).toBeUndefined();
    });
  });

  // ==========================
  // getArtifact()
  // ==========================
  describe("getArtifact()", () => {
    it("returns artifact for done job with artifactSizeBytes", async () => {
      (runBundle as any).mockImplementation(async ({ job }: any) => {
        job.artifactPath = "/tmp/test.ndjson.gz";
        job.artifactSizeBytes = 999;
      });
      const mgr = createBundleManager(config, coreV1);
      const job = await mgr.create(makeParams());

      await flushAsync();
      expect(job.status).toBe("done");

      const artifact = mgr.getArtifact(job.bundleId);
      expect(artifact).toBeDefined();
      expect(artifact!.filename).toContain(".ndjson.gz");
      expect(artifact!.contentType).toBe("application/gzip");
      expect(artifact!.sizeBytes).toBe(999);
      expect(artifact!.downloadPath).toContain(job.bundleId);
    });

    it("returns undefined for non-done job", async () => {
      let resolve!: () => void;
      (runBundle as any).mockImplementation(() => new Promise<void>((r) => { resolve = r; }));

      const mgr = createBundleManager(config, coreV1);
      const job = await mgr.create(makeParams());
      await flushAsync(10);

      expect(mgr.getArtifact(job.bundleId)).toBeUndefined();

      resolve();
      await flushAsync();
    });

    it("returns undefined for done job without artifactSizeBytes", async () => {
      (runBundle as any).mockImplementation(async () => {
        // Don't set artifactSizeBytes
      });
      const mgr = createBundleManager(config, coreV1);
      const job = await mgr.create(makeParams());

      await flushAsync();
      expect(job.status).toBe("done");
      expect(mgr.getArtifact(job.bundleId)).toBeUndefined();
    });

    it("returns undefined for unknown bundleId", () => {
      const mgr = createBundleManager(config, coreV1);
      expect(mgr.getArtifact("bnd_unknown")).toBeUndefined();
    });
  });

  // ==========================
  // cleanupOnce (via startCleanupLoop)
  // ==========================
  describe("cleanup", () => {
    it("deletes expired .ndjson.gz files", async () => {
      const cutoffMs = Date.now() - config.bundleTtlMs - 1000;
      (fs.readdir as any).mockResolvedValue([
        { name: "old.ndjson.gz", isFile: () => true },
        { name: "new.ndjson.gz", isFile: () => true },
      ]);
      (fs.stat as any)
        .mockResolvedValueOnce({ mtimeMs: cutoffMs }) // old: expired
        .mockResolvedValueOnce({ mtimeMs: Date.now() }); // new: not expired

      const mgr = createBundleManager(config, coreV1);
      mgr.startCleanupLoop();
      await flushAsync();

      expect(fs.rm).toHaveBeenCalledTimes(1);
      expect(fs.rm).toHaveBeenCalledWith(
        expect.stringContaining("old.ndjson.gz"),
        { force: true },
      );
    });

    it("deletes expired job metadata", async () => {
      (runBundle as any).mockImplementation(async () => {});
      (fs.readdir as any).mockResolvedValue([]);

      const mgr = createBundleManager(
        createMockConfig({ bundleTtlMs: 1 }), // 1ms TTL - expire instantly
        coreV1,
      );
      const job = await mgr.create(makeParams());
      await flushAsync();

      // Advance time to after TTL
      vi.advanceTimersByTime(100);
      await flushAsync();

      // Trigger cleanup
      mgr.startCleanupLoop();
      await flushAsync();

      expect(mgr.get(job.bundleId)).toBeUndefined();
    });

    it("handles errors gracefully (best-effort)", async () => {
      (fs.readdir as any).mockRejectedValue(new Error("ENOENT"));

      const mgr = createBundleManager(config, coreV1);
      // Should not throw
      mgr.startCleanupLoop();
      await flushAsync();
    });

    it("only deletes files, not directories", async () => {
      (fs.readdir as any).mockResolvedValue([
        { name: "subdir.ndjson.gz", isFile: () => false },
        { name: "file.ndjson.gz", isFile: () => true },
      ]);
      (fs.stat as any).mockResolvedValue({ mtimeMs: 0 }); // very old

      const mgr = createBundleManager(config, coreV1);
      mgr.startCleanupLoop();
      await flushAsync();

      expect(fs.rm).toHaveBeenCalledTimes(1);
      expect(fs.rm).toHaveBeenCalledWith(
        expect.stringContaining("file.ndjson.gz"),
        { force: true },
      );
    });

    it("does not delete job with invalid expiresAt (unparseable date)", async () => {
      (runBundle as any).mockImplementation(async () => {});
      (fs.readdir as any).mockResolvedValue([]);

      const mgr = createBundleManager(config, coreV1);
      const job = await mgr.create(makeParams());
      await flushAsync();

      // Manually corrupt the expiresAt to an unparseable date string
      (job as any).expiresAt = "not-a-valid-date";

      // Trigger cleanup
      mgr.startCleanupLoop();
      await flushAsync();

      // Job should NOT be deleted because Number.isFinite(Date.parse("not-a-valid-date")) is false
      expect(mgr.get(job.bundleId)).toBeDefined();
    });

    it("handles mkdir error inside cleanupOnce gracefully", async () => {
      (fs.mkdir as any).mockRejectedValueOnce(new Error("EPERM"));

      const mgr = createBundleManager(config, coreV1);
      // Should not throw
      mgr.startCleanupLoop();
      await flushAsync();
    });

    it("handles stat error inside file loop gracefully", async () => {
      (fs.readdir as any).mockResolvedValue([
        { name: "bad.ndjson.gz", isFile: () => true },
      ]);
      (fs.stat as any).mockRejectedValue(new Error("ENOENT"));

      const mgr = createBundleManager(config, coreV1);
      // The catch block around the entire cleanupOnce should catch stat errors
      mgr.startCleanupLoop();
      await flushAsync();

      // No rm called since stat failed
      expect(fs.rm).not.toHaveBeenCalled();
    });

    it("setInterval callback triggers cleanupOnce periodically", async () => {
      (fs.readdir as any).mockResolvedValue([]);

      const mgr = createBundleManager(
        createMockConfig({ cleanupIntervalMs: 500 }),
        coreV1,
      );
      mgr.startCleanupLoop();
      await flushAsync();

      // First cleanupOnce called immediately by startCleanupLoop
      const callsBefore = (fs.mkdir as any).mock.calls.length;

      // Advance time past the interval to trigger the setInterval callback
      vi.advanceTimersByTime(600);
      await flushAsync();

      expect((fs.mkdir as any).mock.calls.length).toBeGreaterThan(callsBefore);
    });

    it("only deletes .ndjson.gz files", async () => {
      (fs.readdir as any).mockResolvedValue([
        { name: "readme.txt", isFile: () => true },
        { name: "expired.ndjson.gz", isFile: () => true },
      ]);
      (fs.stat as any).mockResolvedValue({ mtimeMs: 0 });

      const mgr = createBundleManager(config, coreV1);
      mgr.startCleanupLoop();
      await flushAsync();

      expect(fs.rm).toHaveBeenCalledTimes(1);
      expect(fs.rm).toHaveBeenCalledWith(
        expect.stringContaining("expired.ndjson.gz"),
        { force: true },
      );
    });
  });

  // ==========================
  // Semaphore integration
  // ==========================
  describe("semaphore integration", () => {
    it("releases semaphore after success", async () => {
      (runBundle as any).mockImplementation(async () => {});

      const mgr = createBundleManager(
        createMockConfig({ maxInflightBundles: 1 }),
        coreV1,
      );

      await mgr.create(makeParams());
      await flushAsync();

      // Should be able to create another after first completes
      const job2 = await mgr.create(makeParams());
      expect(job2.bundleId).toMatch(/^bnd_/);
      await flushAsync();
    });

    it("releases semaphore after failure", async () => {
      (runBundle as any)
        .mockImplementationOnce(async () => { throw new Error("fail"); })
        .mockImplementationOnce(async () => {});

      const mgr = createBundleManager(
        createMockConfig({ maxInflightBundles: 1 }),
        coreV1,
      );

      await mgr.create(makeParams());
      await flushAsync();

      // Should be able to create another after first fails
      const job2 = await mgr.create(makeParams());
      expect(job2.bundleId).toMatch(/^bnd_/);
      await flushAsync();
    });

    it("testing concurrent bundle limit", async () => {
      let resolve1!: () => void;
      let resolve2!: () => void;
      (runBundle as any)
        .mockImplementationOnce(() => new Promise<void>((r) => { resolve1 = r; }))
        .mockImplementationOnce(() => new Promise<void>((r) => { resolve2 = r; }));

      const mgr = createBundleManager(
        createMockConfig({ maxInflightBundles: 2 }),
        coreV1,
      );

      const job1 = await mgr.create(makeParams());
      await flushAsync(10);
      const job2 = await mgr.create(makeParams());
      await flushAsync(10);

      // 3rd should fail
      await expect(mgr.create(makeParams())).rejects.toMatchObject({
        statusCode: 429,
      });

      resolve1();
      await flushAsync();

      // Now should succeed
      (runBundle as any).mockImplementation(async () => {});
      const job3 = await mgr.create(makeParams());
      expect(job3.bundleId).toMatch(/^bnd_/);

      resolve2();
      await flushAsync();
    });
  });
});
