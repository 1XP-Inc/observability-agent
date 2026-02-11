import { vi } from "vitest";
import type { NormalizedBundleRequest, BundleJob } from "../../src/types";

// ---- Mocks ----

vi.mock("../../src/k8s/compat", () => ({
  listPodsAllNamespaces: vi.fn(),
  listPodsNamespaced: vi.fn(),
  readPod: vi.fn(),
  readPodLog: vi.fn(),
  listEventsNamespaced: vi.fn(),
}));

vi.mock("../../src/bundle-writer", () => ({
  createNdjsonGzipWriter: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ size: 1234 })),
  },
  mkdir: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ size: 1234 })),
}));

vi.mock("undici", () => ({
  fetch: vi.fn(),
}));

import { runBundle } from "../../src/k8s/bundle-runner";
import {
  listPodsAllNamespaces,
  listPodsNamespaced,
  readPod,
  readPodLog,
  listEventsNamespaced,
} from "../../src/k8s/compat";
import { createNdjsonGzipWriter } from "../../src/bundle-writer";
import { createMockConfig, createMockCoreV1Api, createMockPod, createMockEvent } from "../helpers";
import { fetch } from "undici";
import fs from "node:fs/promises";

// ---- Helpers ----

function makeWriter() {
  const records: any[] = [];
  const writer = {
    writeRecord: vi.fn(async (r: any) => { records.push(r); }),
    finalize: vi.fn(async () => {}),
    destroy: vi.fn(),
  };
  (createNdjsonGzipWriter as any).mockReturnValue(writer);
  return { writer, records };
}

function makeJob(overrides?: Partial<BundleJob>): BundleJob {
  return {
    bundleId: "bnd_test123",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    params: makeParams(),
    ...overrides,
  };
}

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

function setupPodList(pods: any[]) {
  (listPodsNamespaced as any).mockResolvedValue({ items: pods, metadata: {} });
  (listPodsAllNamespaces as any).mockResolvedValue({ items: pods, metadata: {} });
}

function setupPodLogs(text: string) {
  (readPodLog as any).mockResolvedValue(text);
}

// ---- Tests ----

describe("runBundle", () => {
  const config = createMockConfig();
  const coreV1 = createMockCoreV1Api();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ==========================
  // General
  // ==========================
  describe("general", () => {
    it("creates bundle directory", async () => {
      const { writer } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1" });
      setupPodList([pod]);
      setupPodLogs("");
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob();
      await runBundle({ config, coreV1, job });

      expect(fs.mkdir).toHaveBeenCalledWith(config.bundleDir, { recursive: true, mode: 0o700 });
    });

    it("writes meta record first", async () => {
      const { writer, records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1" });
      setupPodList([pod]);
      setupPodLogs("");
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob();
      await runBundle({ config, coreV1, job });

      expect(records[0]).toMatchObject({
        type: "meta",
        bundleId: job.bundleId,
        createdAt: job.createdAt,
      });
    });

    it("calls writer.finalize() at end", async () => {
      const { writer } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1" });
      setupPodList([pod]);
      setupPodLogs("");
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob();
      await runBundle({ config, coreV1, job });

      expect(writer.finalize).toHaveBeenCalledOnce();
    });

    it("sets job.artifactPath and job.artifactSizeBytes", async () => {
      makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1" });
      setupPodList([pod]);
      setupPodLogs("");
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob();
      await runBundle({ config, coreV1, job });

      expect(job.artifactPath).toContain("bnd_test123.ndjson.gz");
      expect(job.artifactSizeBytes).toBe(1234);
    });
  });

  // ==========================
  // Logs collection
  // ==========================
  describe("logs collection", () => {
    it("selector target: calls listPodsNamespaced for specific namespace", async () => {
      makeWriter();
      const pod = createMockPod({ namespace: "ns1", name: "p1" });
      setupPodList([pod]);
      setupPodLogs("");
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          target: { kind: "selector", namespace: "ns1", selector: "app=web" },
        }),
      });
      await runBundle({ config, coreV1, job });

      expect(listPodsNamespaced).toHaveBeenCalled();
      expect(listPodsAllNamespaces).not.toHaveBeenCalled();
    });

    it("selector target: calls listPodsAllNamespaces when ns='*'", async () => {
      makeWriter();
      const pod = createMockPod({ namespace: "ns1", name: "p1" });
      setupPodList([pod]);
      setupPodLogs("");
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          target: { kind: "selector", namespace: "*", selector: "app=web" },
        }),
      });
      await runBundle({ config, coreV1, job });

      expect(listPodsAllNamespaces).toHaveBeenCalled();
      expect(listPodsNamespaced).not.toHaveBeenCalled();
    });

    it("pods target: calls readPod for each pod", async () => {
      makeWriter();
      const pod1 = createMockPod({ namespace: "ns1", name: "p1" });
      const pod2 = createMockPod({ namespace: "ns2", name: "p2" });
      (readPod as any)
        .mockResolvedValueOnce(pod1)
        .mockResolvedValueOnce(pod2);
      setupPodLogs("");
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          target: {
            kind: "pods",
            pods: [
              { namespace: "ns1", pod: "p1" },
              { namespace: "ns2", pod: "p2" },
            ],
          },
        }),
      });
      await runBundle({ config, coreV1, job });

      expect(readPod).toHaveBeenCalledTimes(2);
    });

    it("maxPods exceeded with selector throws HttpError 400", async () => {
      makeWriter();
      const pods = Array.from({ length: 3 }, (_, i) =>
        createMockPod({ namespace: "default", name: `p${i}` })
      );
      setupPodList(pods);

      const job = makeJob({
        params: makeParams({
          limits: { ...makeParams().limits, maxPods: 2 },
        }),
      });

      await expect(runBundle({ config, coreV1, job })).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("maxPods exceeded"),
      });
    });

    it("maxPods exceeded via _continue flag throws HttpError 400", async () => {
      makeWriter();
      const pods = [createMockPod({ namespace: "default", name: "p0" })];
      (listPodsNamespaced as any).mockResolvedValue({
        items: pods,
        metadata: { _continue: "token" },
      });

      const job = makeJob({
        params: makeParams({
          limits: { ...makeParams().limits, maxPods: 2 },
        }),
      });

      await expect(runBundle({ config, coreV1, job })).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("maxPods exceeded"),
      });
    });

    it("pod not found with pods target throws HttpError 400", async () => {
      makeWriter();
      const err: any = new Error("not found");
      err.statusCode = 404;
      (readPod as any).mockRejectedValue(err);

      const job = makeJob({
        params: makeParams({
          target: { kind: "pods", pods: [{ namespace: "ns1", pod: "missing" }] },
        }),
      });

      await expect(runBundle({ config, coreV1, job })).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("Pod not found"),
      });
    });

    it("current logs: splits by newline, writes log records", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      (readPodLog as any).mockResolvedValue("2024-01-01T00:00:00Z hello\n2024-01-01T00:00:01Z world\n");
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob();
      await runBundle({ config, coreV1, job });

      const logRecords = records.filter((r) => r.type === "log");
      expect(logRecords.length).toBe(2);
      expect(logRecords[0]).toMatchObject({
        type: "log",
        namespace: "default",
        pod: "p1",
        container: "main",
        ts: "2024-01-01T00:00:00Z",
        line: "hello",
      });
      expect(logRecords[1]).toMatchObject({ line: "world" });
    });

    it("previous logs enabled: fetches previous, writes log records", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      // first call = current, second call = previous
      (readPodLog as any)
        .mockResolvedValueOnce("2024-01-01T00:00:00Z current\n")
        .mockResolvedValueOnce("2024-01-01T00:00:00Z previous\n");
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          include: {
            ...makeParams().include,
            logs: { ...makeParams().include.logs, previous: true },
          },
        }),
      });
      await runBundle({ config, coreV1, job });

      const logRecords = records.filter((r) => r.type === "log");
      expect(logRecords.some((r) => r.line === "current")).toBe(true);
      expect(logRecords.some((r) => r.line === "previous")).toBe(true);
    });

    it("previous logs: K8s returns 400 writes skipped record", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      (readPodLog as any)
        .mockResolvedValueOnce("") // current
        .mockRejectedValueOnce({ statusCode: 400, message: "bad request" }); // previous
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          include: {
            ...makeParams().include,
            logs: { ...makeParams().include.logs, previous: true },
          },
        }),
      });
      await runBundle({ config, coreV1, job });

      const skipped = records.filter((r) => r.type === "log" && r.skipped === true);
      expect(skipped.length).toBe(1);
      expect(skipped[0].reason).toBe("no_previous_container");
    });

    it("previous logs: K8s returns 404 writes skipped record", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      (readPodLog as any)
        .mockResolvedValueOnce("")
        .mockRejectedValueOnce({ statusCode: 404, message: "not found" });
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          include: {
            ...makeParams().include,
            logs: { ...makeParams().include.logs, previous: true },
          },
        }),
      });
      await runBundle({ config, coreV1, job });

      const skipped = records.filter((r) => r.type === "log" && r.skipped === true);
      expect(skipped.length).toBe(1);
    });

    it("previous logs: error message 'previous terminated container' writes skipped", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      (readPodLog as any)
        .mockResolvedValueOnce("")
        .mockRejectedValueOnce(new Error("previous terminated container not found"));
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          include: {
            ...makeParams().include,
            logs: { ...makeParams().include.logs, previous: true },
          },
        }),
      });
      await runBundle({ config, coreV1, job });

      const skipped = records.filter((r) => r.type === "log" && r.skipped === true);
      expect(skipped.length).toBe(1);
    });

    it("absolute time window: filters lines by start/end", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      (readPodLog as any).mockResolvedValue(
        "2024-01-01T00:00:00Z before\n" +
        "2024-01-01T12:00:00Z inside\n" +
        "2024-01-02T00:00:01Z after\n"
      );
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          timeWindow: { kind: "absolute", start: "2024-01-01T06:00:00Z", end: "2024-01-02T00:00:00Z" },
          include: {
            ...makeParams().include,
            logs: { enabled: true, tailLines: 100, previous: false, timestamps: true, excludePatterns: [] },
          },
        }),
      });
      await runBundle({ config, coreV1, job });

      const logRecords = records.filter((r) => r.type === "log");
      expect(logRecords.length).toBe(1);
      expect(logRecords[0].line).toBe("inside");
    });

    it("absolute time window: line without parseable timestamp is skipped", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      // A line with no space, so parseLogLine returns msg only (no ts)
      (readPodLog as any).mockResolvedValue("no-timestamp-line\n");
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          timeWindow: { kind: "absolute", start: "2024-01-01T00:00:00Z", end: "2024-01-02T00:00:00Z" },
        }),
      });
      await runBundle({ config, coreV1, job });

      const logRecords = records.filter((r) => r.type === "log");
      expect(logRecords.length).toBe(0);
    });

    it("absolute time window: line with invalid timestamp is skipped", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      (readPodLog as any).mockResolvedValue("not-a-date some message\n");
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          timeWindow: { kind: "absolute", start: "2024-01-01T00:00:00Z", end: "2024-01-02T00:00:00Z" },
        }),
      });
      await runBundle({ config, coreV1, job });

      const logRecords = records.filter((r) => r.type === "log");
      expect(logRecords.length).toBe(0);
    });

    it("relative time window: uses sinceSeconds", async () => {
      makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      setupPodLogs("2024-01-01T00:00:00Z line\n");
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          timeWindow: { kind: "relative", sinceSeconds: 300 },
        }),
      });
      await runBundle({ config, coreV1, job });

      const calls = (readPodLog as any).mock.calls;
      expect(calls[0][0]).toMatchObject({ sinceSeconds: 300 });
    });

    it("excludePatterns: lines matching patterns are filtered out", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      (readPodLog as any).mockResolvedValue(
        "2024-01-01T00:00:00Z healthcheck ok\n" +
        "2024-01-01T00:00:01Z important msg\n" +
        "2024-01-01T00:00:02Z debug info\n"
      );
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          include: {
            ...makeParams().include,
            logs: { enabled: true, tailLines: 100, previous: false, timestamps: true, excludePatterns: ["healthcheck", "debug"] },
          },
        }),
      });
      await runBundle({ config, coreV1, job });

      const logRecords = records.filter((r) => r.type === "log");
      expect(logRecords.length).toBe(1);
      expect(logRecords[0].line).toBe("important msg");
    });

    it("maxTotalLogLines exceeded throws HttpError 400", async () => {
      makeWriter();
      // 2 pods x 1 container x 100 tailLines = 200 expected > maxTotalLogLines=50
      const pod1 = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      const pod2 = createMockPod({ namespace: "default", name: "p2", containers: ["main"] });
      setupPodList([pod1, pod2]);

      const job = makeJob({
        params: makeParams({
          include: {
            ...makeParams().include,
            logs: { enabled: true, tailLines: 100, previous: false, timestamps: true, excludePatterns: [] },
          },
          limits: { ...makeParams().limits, maxTotalLogLines: 50 },
        }),
      });

      await expect(runBundle({ config, coreV1, job })).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("maxTotalLogLines"),
      });
    });

    it("maxTotalLogLines with previous multiplier", async () => {
      makeWriter();
      // 1 pod x 1 container x 100 tailLines x 2 (previous) = 200 expected > 150
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);

      const job = makeJob({
        params: makeParams({
          include: {
            ...makeParams().include,
            logs: { enabled: true, tailLines: 100, previous: true, timestamps: true, excludePatterns: [] },
          },
          limits: { ...makeParams().limits, maxTotalLogLines: 150 },
        }),
      });

      await expect(runBundle({ config, coreV1, job })).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("maxTotalLogLines"),
      });
    });

    it("logs disabled: skips log collection entirely", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          include: {
            ...makeParams().include,
            logs: { enabled: false, tailLines: 100, previous: false, timestamps: true, excludePatterns: [] },
          },
        }),
      });
      await runBundle({ config, coreV1, job });

      expect(readPodLog).not.toHaveBeenCalled();
      expect(records.filter((r) => r.type === "log").length).toBe(0);
    });

    it("pod with initContainers: included in container list", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({
        namespace: "default",
        name: "p1",
        containers: ["main"],
        initContainers: ["init-db"],
      });
      setupPodList([pod]);
      (readPodLog as any).mockResolvedValue("2024-01-01T00:00:00Z line\n");
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob();
      await runBundle({ config, coreV1, job });

      // Should fetch logs for both main and init-db
      expect(readPodLog).toHaveBeenCalledTimes(2);
      const logRecords = records.filter((r) => r.type === "log");
      const containers = new Set(logRecords.map((r) => r.container));
      expect(containers.has("main")).toBe(true);
      expect(containers.has("init-db")).toBe(true);
    });

    it("pod missing namespace throws HttpError 500", async () => {
      makeWriter();
      const badPod = { metadata: { name: "p1" }, spec: { containers: [{ name: "main" }] }, status: {} };
      setupPodList([badPod]);

      const job = makeJob();
      await expect(runBundle({ config, coreV1, job })).rejects.toMatchObject({
        statusCode: 500,
        message: expect.stringContaining("namespace/name"),
      });
    });

    it("pod missing name throws HttpError 500", async () => {
      makeWriter();
      const badPod = { metadata: { namespace: "default" }, spec: { containers: [{ name: "main" }] }, status: {} };
      setupPodList([badPod]);

      const job = makeJob();
      await expect(runBundle({ config, coreV1, job })).rejects.toMatchObject({
        statusCode: 500,
        message: expect.stringContaining("namespace/name"),
      });
    });

    it("pod with no metadata at all throws HttpError 500", async () => {
      makeWriter();
      const badPod = { spec: { containers: [{ name: "main" }] }, status: {} };
      setupPodList([badPod]);

      const job = makeJob();
      await expect(runBundle({ config, coreV1, job })).rejects.toMatchObject({
        statusCode: 500,
        message: expect.stringContaining("namespace/name"),
      });
    });

    it("pod with empty string namespace and empty string name throws HttpError 500", async () => {
      makeWriter();
      const badPod = { metadata: { namespace: "", name: "" }, spec: { containers: [{ name: "main" }] }, status: {} };
      setupPodList([badPod]);

      const job = makeJob();
      await expect(runBundle({ config, coreV1, job })).rejects.toMatchObject({
        statusCode: 500,
        message: expect.stringContaining("namespace/name"),
      });
    });

    it("pod with no spec.containers and no spec.initContainers still works", async () => {
      const { records } = makeWriter();
      const pod = { metadata: { namespace: "default", name: "p1" }, spec: {}, status: { podIP: "10.0.0.1" } };
      setupPodList([pod]);
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob();
      await runBundle({ config, coreV1, job });

      // No containers means no log fetches
      expect(readPodLog).not.toHaveBeenCalled();
    });

    it("timestamps=false: parseLogLine returns full line as msg", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      (readPodLog as any).mockResolvedValue("hello world no timestamp\n");
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          include: {
            ...makeParams().include,
            logs: { enabled: true, tailLines: 100, previous: false, timestamps: false, excludePatterns: [] },
          },
        }),
      });
      await runBundle({ config, coreV1, job });

      const logRecords = records.filter((r) => r.type === "log");
      expect(logRecords.length).toBe(1);
      expect(logRecords[0].line).toBe("hello world no timestamp");
      expect(logRecords[0].ts).toBeUndefined();
    });

    it("previous logs with absolute time window: filters lines by start/end", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      (readPodLog as any)
        .mockResolvedValueOnce("") // current
        .mockResolvedValueOnce(
          "2024-01-01T00:00:00Z before\n" +
          "2024-01-01T12:00:00Z inside\n" +
          "2024-01-02T00:00:01Z after\n"
        ); // previous
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          timeWindow: { kind: "absolute", start: "2024-01-01T06:00:00Z", end: "2024-01-02T00:00:00Z" },
          include: {
            ...makeParams().include,
            logs: { enabled: true, tailLines: 100, previous: true, timestamps: true, excludePatterns: [] },
          },
        }),
      });
      await runBundle({ config, coreV1, job });

      const logRecords = records.filter((r) => r.type === "log" && !r.skipped);
      expect(logRecords.length).toBe(1);
      expect(logRecords[0].line).toBe("inside");
    });

    it("previous logs with excludePatterns: patterns are applied", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      (readPodLog as any)
        .mockResolvedValueOnce("")
        .mockResolvedValueOnce("2024-01-01T00:00:00Z debug\n2024-01-01T00:00:01Z keep\n");
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          include: {
            ...makeParams().include,
            logs: { enabled: true, tailLines: 100, previous: true, timestamps: true, excludePatterns: ["debug"] },
          },
        }),
      });
      await runBundle({ config, coreV1, job });

      const logRecords = records.filter((r) => r.type === "log" && !r.skipped);
      expect(logRecords.length).toBe(1);
      expect(logRecords[0].line).toBe("keep");
    });

    it("collectLogsForContainer re-throws non-previous errors", async () => {
      makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      (readPodLog as any).mockRejectedValue({ statusCode: 500, message: "Internal Server Error" });

      const job = makeJob();
      await expect(runBundle({ config, coreV1, job })).rejects.toMatchObject({
        statusCode: 500,
      });
    });

    it("previous logs: error with response.statusCode=400 is skipped", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      (readPodLog as any)
        .mockResolvedValueOnce("")
        .mockRejectedValueOnce({ response: { statusCode: 400 }, message: "bad" });
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          include: {
            ...makeParams().include,
            logs: { enabled: true, tailLines: 100, previous: true, timestamps: true, excludePatterns: [] },
          },
        }),
      });
      await runBundle({ config, coreV1, job });

      const skipped = records.filter((r) => r.type === "log" && r.skipped);
      expect(skipped.length).toBe(1);
    });

    it("previous logs: error with response.status=404 is skipped", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      (readPodLog as any)
        .mockResolvedValueOnce("")
        .mockRejectedValueOnce({ response: { status: 404 }, message: "missing" });
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          include: {
            ...makeParams().include,
            logs: { enabled: true, tailLines: 100, previous: true, timestamps: true, excludePatterns: [] },
          },
        }),
      });
      await runBundle({ config, coreV1, job });

      const skipped = records.filter((r) => r.type === "log" && r.skipped);
      expect(skipped.length).toBe(1);
    });

    it("previous logs: error with body.code=400 is skipped", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      (readPodLog as any)
        .mockResolvedValueOnce("")
        .mockRejectedValueOnce({ body: { code: 400 }, message: "bad" });
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          include: {
            ...makeParams().include,
            logs: { enabled: true, tailLines: 100, previous: true, timestamps: true, excludePatterns: [] },
          },
        }),
      });
      await runBundle({ config, coreV1, job });

      const skipped = records.filter((r) => r.type === "log" && r.skipped);
      expect(skipped.length).toBe(1);
    });

    it("previous logs: message containing 'previous log' is skipped", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      (readPodLog as any)
        .mockResolvedValueOnce("")
        .mockRejectedValueOnce(new Error("previous log not available"));
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          include: {
            ...makeParams().include,
            logs: { enabled: true, tailLines: 100, previous: true, timestamps: true, excludePatterns: [] },
          },
        }),
      });
      await runBundle({ config, coreV1, job });

      const skipped = records.filter((r) => r.type === "log" && r.skipped);
      expect(skipped.length).toBe(1);
    });

    it("previous logs: message containing 'no previous' is skipped", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      (readPodLog as any)
        .mockResolvedValueOnce("")
        .mockRejectedValueOnce(new Error("no previous container"));
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          include: {
            ...makeParams().include,
            logs: { enabled: true, tailLines: 100, previous: true, timestamps: true, excludePatterns: [] },
          },
        }),
      });
      await runBundle({ config, coreV1, job });

      const skipped = records.filter((r) => r.type === "log" && r.skipped);
      expect(skipped.length).toBe(1);
    });

    it("previous logs: error with non-string message still checks status code", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      // err.message is a number (not a string), so msg check falls through, but statusCode=400 triggers skip
      (readPodLog as any)
        .mockResolvedValueOnce("")
        .mockRejectedValueOnce({ statusCode: 400, message: 12345 });
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          include: {
            ...makeParams().include,
            logs: { enabled: true, tailLines: 100, previous: true, timestamps: true, excludePatterns: [] },
          },
        }),
      });
      await runBundle({ config, coreV1, job });

      const skipped = records.filter((r) => r.type === "log" && r.skipped);
      expect(skipped.length).toBe(1);
    });

    it("previous logs: error with no message property but status 404 is skipped", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      (readPodLog as any)
        .mockResolvedValueOnce("")
        .mockRejectedValueOnce({ statusCode: 404 }); // no message at all
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          include: {
            ...makeParams().include,
            logs: { enabled: true, tailLines: 100, previous: true, timestamps: true, excludePatterns: [] },
          },
        }),
      });
      await runBundle({ config, coreV1, job });

      const skipped = records.filter((r) => r.type === "log" && r.skipped);
      expect(skipped.length).toBe(1);
    });

    it("non-previous error with status 400 is re-thrown (previous=false)", async () => {
      makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      // This is a current log fetch (previous=false), so 400 should re-throw
      (readPodLog as any).mockRejectedValue({ statusCode: 400, message: "bad request" });

      const job = makeJob();
      await expect(runBundle({ config, coreV1, job })).rejects.toMatchObject({
        statusCode: 400,
      });
    });

    it("maxPods exceeded via _continue flag on listPodsAllNamespaces (ns=*)", async () => {
      makeWriter();
      const pods = [createMockPod({ namespace: "default", name: "p0" })];
      (listPodsAllNamespaces as any).mockResolvedValue({
        items: pods,
        metadata: { _continue: "token" },
      });

      const job = makeJob({
        params: makeParams({
          target: { kind: "selector", namespace: "*", selector: "app=web" },
          limits: { ...makeParams().limits, maxPods: 2 },
        }),
      });

      await expect(runBundle({ config, coreV1, job })).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("maxPods exceeded"),
      });
    });

    it("listPodsAllNamespaces with undefined items defaults to empty array", async () => {
      const { records } = makeWriter();
      (listPodsAllNamespaces as any).mockResolvedValue({ metadata: {} });
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          target: { kind: "selector", namespace: "*", selector: "app=web" },
        }),
      });
      await runBundle({ config, coreV1, job });

      // No pods = no logs
      expect(readPodLog).not.toHaveBeenCalled();
    });

    it("listPodsNamespaced with undefined items defaults to empty array", async () => {
      const { records } = makeWriter();
      (listPodsNamespaced as any).mockResolvedValue({ metadata: {} });
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob();
      await runBundle({ config, coreV1, job });

      expect(readPodLog).not.toHaveBeenCalled();
    });

    it("sinceTime is passed for absolute time window", async () => {
      makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1", containers: ["main"] });
      setupPodList([pod]);
      (readPodLog as any).mockResolvedValue("2024-01-01T12:00:00Z msg\n");
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob({
        params: makeParams({
          timeWindow: { kind: "absolute", start: "2024-01-01T00:00:00Z", end: "2024-01-02T00:00:00Z" },
        }),
      });
      await runBundle({ config, coreV1, job });

      expect((readPodLog as any).mock.calls[0][0]).toMatchObject({
        sinceTime: "2024-01-01T00:00:00Z",
      });
    });
  });

  // ==========================
  // Events collection
  // ==========================
  describe("events collection", () => {
    it("collects events for each namespace", async () => {
      const { records } = makeWriter();
      const pod1 = createMockPod({ namespace: "ns1", name: "p1" });
      const pod2 = createMockPod({ namespace: "ns2", name: "p2" });
      setupPodList([pod1, pod2]);
      setupPodLogs("");

      const now = new Date().toISOString();
      (listEventsNamespaced as any)
        .mockResolvedValueOnce({
          items: [createMockEvent({ namespace: "ns1", lastTimestamp: now, involvedObject: { kind: "Pod", name: "p1", namespace: "ns1" } })],
        })
        .mockResolvedValueOnce({
          items: [createMockEvent({ namespace: "ns2", lastTimestamp: now, involvedObject: { kind: "Pod", name: "p2", namespace: "ns2" } })],
        });

      const job = makeJob({
        params: makeParams({
          target: { kind: "selector", namespace: "*", selector: "app=web" },
        }),
      });
      await runBundle({ config, coreV1, job });

      expect(listEventsNamespaced).toHaveBeenCalledTimes(2);
      const eventRecords = records.filter((r) => r.type === "event");
      expect(eventRecords.length).toBe(2);
    });

    it("filters events by relative time range", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1" });
      setupPodList([pod]);
      setupPodLogs("");

      const recent = new Date().toISOString();
      const old = new Date(Date.now() - 7200_000).toISOString(); // 2 hours ago

      (listEventsNamespaced as any).mockResolvedValue({
        items: [
          createMockEvent({ lastTimestamp: recent, involvedObject: { kind: "Pod", name: "p1", namespace: "default" } }),
          createMockEvent({ lastTimestamp: old, involvedObject: { kind: "Pod", name: "p1", namespace: "default" } }),
        ],
      });

      const job = makeJob({
        params: makeParams({
          timeWindow: { kind: "relative", sinceSeconds: 600 }, // 10 min
        }),
      });
      await runBundle({ config, coreV1, job });

      const eventRecords = records.filter((r) => r.type === "event");
      expect(eventRecords.length).toBe(1);
    });

    it("filters events by absolute time range", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1" });
      setupPodList([pod]);
      setupPodLogs("");

      (listEventsNamespaced as any).mockResolvedValue({
        items: [
          createMockEvent({ lastTimestamp: "2024-01-01T12:00:00Z", involvedObject: { kind: "Pod", name: "p1", namespace: "default" } }),
          createMockEvent({ lastTimestamp: "2024-01-01T00:00:00Z", involvedObject: { kind: "Pod", name: "p1", namespace: "default" } }),
          createMockEvent({ lastTimestamp: "2024-01-02T12:00:00Z", involvedObject: { kind: "Pod", name: "p1", namespace: "default" } }),
        ],
      });

      const job = makeJob({
        params: makeParams({
          timeWindow: { kind: "absolute", start: "2024-01-01T06:00:00Z", end: "2024-01-02T00:00:00Z" },
          include: {
            logs: { enabled: false, tailLines: 100, previous: false, timestamps: true, excludePatterns: [] },
            events: { enabled: true },
            metrics: { enabled: false },
          },
        }),
      });
      await runBundle({ config, coreV1, job });

      const eventRecords = records.filter((r) => r.type === "event");
      expect(eventRecords.length).toBe(1);
      expect(eventRecords[0].ts).toBe("2024-01-01T12:00:00Z");
    });

    it("filters by involvedObject.kind === 'Pod' and name in pod set", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1" });
      setupPodList([pod]);
      setupPodLogs("");

      const now = new Date().toISOString();
      (listEventsNamespaced as any).mockResolvedValue({
        items: [
          createMockEvent({ lastTimestamp: now, involvedObject: { kind: "Pod", name: "p1", namespace: "default" } }),
          createMockEvent({ lastTimestamp: now, involvedObject: { kind: "Pod", name: "other-pod", namespace: "default" } }),
        ],
      });

      const job = makeJob();
      await runBundle({ config, coreV1, job });

      const eventRecords = records.filter((r) => r.type === "event");
      expect(eventRecords.length).toBe(1);
      expect(eventRecords[0].involvedObject.name).toBe("p1");
    });

    it("non-Pod events: skipped (obj.kind !== 'Pod')", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1" });
      setupPodList([pod]);
      setupPodLogs("");

      const now = new Date().toISOString();
      (listEventsNamespaced as any).mockResolvedValue({
        items: [
          createMockEvent({ lastTimestamp: now, involvedObject: { kind: "Service", name: "svc1", namespace: "default" } }),
        ],
      });

      const job = makeJob();
      await runBundle({ config, coreV1, job });

      const eventRecords = records.filter((r) => r.type === "event");
      expect(eventRecords.length).toBe(0);
    });

    it("events without timestamp: skipped", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1" });
      setupPodList([pod]);
      setupPodLogs("");

      (listEventsNamespaced as any).mockResolvedValue({
        items: [{
          metadata: {},
          reason: "Test",
          message: "msg",
          involvedObject: { kind: "Pod", name: "p1", namespace: "default" },
          // no lastTimestamp, eventTime, or creationTimestamp
        }],
      });

      const job = makeJob();
      await runBundle({ config, coreV1, job });

      const eventRecords = records.filter((r) => r.type === "event");
      expect(eventRecords.length).toBe(0);
    });

    it("events with invalid timestamp: skipped", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1" });
      setupPodList([pod]);
      setupPodLogs("");

      (listEventsNamespaced as any).mockResolvedValue({
        items: [{
          metadata: {},
          lastTimestamp: "not-a-date",
          reason: "Test",
          message: "msg",
          involvedObject: { kind: "Pod", name: "p1", namespace: "default" },
        }],
      });

      const job = makeJob();
      await runBundle({ config, coreV1, job });

      const eventRecords = records.filter((r) => r.type === "event");
      expect(eventRecords.length).toBe(0);
    });

    it("events disabled: skips collection", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1" });
      setupPodList([pod]);
      setupPodLogs("");

      const job = makeJob({
        params: makeParams({
          include: {
            ...makeParams().include,
            events: { enabled: false },
          },
        }),
      });
      await runBundle({ config, coreV1, job });

      expect(listEventsNamespaced).not.toHaveBeenCalled();
      expect(records.filter((r) => r.type === "event").length).toBe(0);
    });

    it("eventTimestamp prefers lastTimestamp over eventTime", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1" });
      setupPodList([pod]);
      setupPodLogs("");

      const lt = new Date().toISOString();
      const et = new Date(Date.now() - 1000).toISOString();
      (listEventsNamespaced as any).mockResolvedValue({
        items: [{
          metadata: { creationTimestamp: "2020-01-01T00:00:00Z" },
          lastTimestamp: lt,
          eventTime: et,
          reason: "Started",
          message: "msg",
          involvedObject: { kind: "Pod", name: "p1", namespace: "default" },
        }],
      });

      const job = makeJob();
      await runBundle({ config, coreV1, job });

      const eventRecords = records.filter((r) => r.type === "event");
      expect(eventRecords.length).toBe(1);
      expect(eventRecords[0].ts).toBe(lt);
    });

    it("eventTimestamp falls back to eventTime when lastTimestamp missing", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1" });
      setupPodList([pod]);
      setupPodLogs("");

      const et = new Date().toISOString();
      (listEventsNamespaced as any).mockResolvedValue({
        items: [{
          metadata: { creationTimestamp: "2020-01-01T00:00:00Z" },
          eventTime: et,
          reason: "Started",
          message: "msg",
          involvedObject: { kind: "Pod", name: "p1", namespace: "default" },
        }],
      });

      const job = makeJob();
      await runBundle({ config, coreV1, job });

      const eventRecords = records.filter((r) => r.type === "event");
      expect(eventRecords.length).toBe(1);
      expect(eventRecords[0].ts).toBe(et);
    });

    it("eventTimestamp: all timestamp fields undefined returns undefined (event skipped)", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1" });
      setupPodList([pod]);
      setupPodLogs("");

      (listEventsNamespaced as any).mockResolvedValue({
        items: [{
          // No lastTimestamp, no eventTime
          metadata: {}, // No creationTimestamp either
          reason: "Test",
          message: "msg",
          involvedObject: { kind: "Pod", name: "p1", namespace: "default" },
        }],
      });

      const job = makeJob();
      await runBundle({ config, coreV1, job });

      const eventRecords = records.filter((r) => r.type === "event");
      expect(eventRecords.length).toBe(0);
    });

    it("eventTimestamp: no metadata at all returns undefined (event skipped)", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1" });
      setupPodList([pod]);
      setupPodLogs("");

      (listEventsNamespaced as any).mockResolvedValue({
        items: [{
          // No lastTimestamp, no eventTime, no metadata
          reason: "Test",
          message: "msg",
          involvedObject: { kind: "Pod", name: "p1", namespace: "default" },
        }],
      });

      const job = makeJob();
      await runBundle({ config, coreV1, job });

      const eventRecords = records.filter((r) => r.type === "event");
      expect(eventRecords.length).toBe(0);
    });

    it("listEventsNamespaced returns undefined items (defaults to empty)", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1" });
      setupPodList([pod]);
      setupPodLogs("");

      (listEventsNamespaced as any).mockResolvedValue({ metadata: {} });

      const job = makeJob();
      await runBundle({ config, coreV1, job });

      const eventRecords = records.filter((r) => r.type === "event");
      expect(eventRecords.length).toBe(0);
    });

    it("event with involvedObject missing name: filtered out (cannot match to any pod)", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1" });
      setupPodList([pod]);
      setupPodLogs("");

      const now = new Date().toISOString();
      (listEventsNamespaced as any).mockResolvedValue({
        items: [{
          metadata: {},
          lastTimestamp: now,
          reason: "Test",
          message: "msg",
          involvedObject: { kind: "Pod", namespace: "default" }, // name is undefined
        }],
      });

      const job = makeJob();
      await runBundle({ config, coreV1, job });

      // Pod event without a name cannot be matched to any pod → filtered out
      const eventRecords = records.filter((r) => r.type === "event");
      expect(eventRecords.length).toBe(0);
    });

    it("eventTimestamp falls back to creationTimestamp", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1" });
      setupPodList([pod]);
      setupPodLogs("");

      const ct = new Date().toISOString();
      (listEventsNamespaced as any).mockResolvedValue({
        items: [{
          metadata: { creationTimestamp: ct },
          reason: "Started",
          message: "msg",
          involvedObject: { kind: "Pod", name: "p1", namespace: "default" },
        }],
      });

      const job = makeJob();
      await runBundle({ config, coreV1, job });

      const eventRecords = records.filter((r) => r.type === "event");
      expect(eventRecords.length).toBe(1);
      expect(eventRecords[0].ts).toBe(ct);
    });
  });

  // ==========================
  // Metrics collection
  // ==========================
  describe("metrics collection", () => {
    const metricsParams = (overrides?: Partial<NormalizedBundleRequest>) =>
      makeParams({
        include: {
          logs: { enabled: false, tailLines: 100, previous: false, timestamps: true, excludePatterns: [] },
          events: { enabled: false },
          metrics: { enabled: true },
        },
        ...overrides,
      });

    it("pod with prometheus.io/scrape=true + port fetches metrics", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({
        namespace: "default",
        name: "p1",
        annotations: { "prometheus.io/scrape": "true", "prometheus.io/port": "9090" },
        podIP: "10.0.0.1",
      });
      setupPodList([pod]);
      (fetch as any).mockResolvedValue({ ok: true, status: 200, text: async () => "metric_a 1\n" });

      const job = makeJob({ params: metricsParams() });
      await runBundle({ config, coreV1, job });

      const metricsOk = records.filter((r) => r.type === "metrics_text" && r.ok === true);
      expect(metricsOk.length).toBe(1);
      expect(metricsOk[0].content).toBe("metric_a 1\n");
      expect(metricsOk[0].port).toBe(9090);
      expect(metricsOk[0].path).toBe("/metrics");
    });

    it("pod without annotations writes skipped record (annotation_missing)", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({ namespace: "default", name: "p1" });
      setupPodList([pod]);

      const job = makeJob({ params: metricsParams() });
      await runBundle({ config, coreV1, job });

      const skipped = records.filter((r) => r.type === "metrics_text" && r.skipped === true);
      expect(skipped.length).toBe(1);
      expect(skipped[0].reason).toBe("annotation_missing");
    });

    it("pod with annotation but no podIP writes error record (podIP_missing)", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({
        namespace: "default",
        name: "p1",
        annotations: { "prometheus.io/scrape": "true", "prometheus.io/port": "9090" },
        podIP: undefined,
      });
      // Override podIP to be missing
      const rawPod = createMockPod({
        namespace: "default",
        name: "p1",
        annotations: { "prometheus.io/scrape": "true", "prometheus.io/port": "9090" },
      });
      rawPod.status.podIP = undefined;
      setupPodList([rawPod]);

      const job = makeJob({ params: metricsParams() });
      await runBundle({ config, coreV1, job });

      const errRecords = records.filter((r) => r.type === "metrics_text" && r.error === "podIP_missing");
      expect(errRecords.length).toBe(1);
    });

    it("successful fetch writes ok:true record", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({
        namespace: "default",
        name: "p1",
        annotations: { "prometheus.io/scrape": "true", "prometheus.io/port": "9090" },
      });
      setupPodList([pod]);
      (fetch as any).mockResolvedValue({ ok: true, status: 200, text: async () => "counter 42\n" });

      const job = makeJob({ params: metricsParams() });
      await runBundle({ config, coreV1, job });

      const ok = records.filter((r) => r.type === "metrics_text" && r.ok === true);
      expect(ok.length).toBe(1);
    });

    it("non-200 response writes ok:false record", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({
        namespace: "default",
        name: "p1",
        annotations: { "prometheus.io/scrape": "true", "prometheus.io/port": "9090" },
      });
      setupPodList([pod]);
      (fetch as any).mockResolvedValue({ ok: false, status: 503, text: async () => "service unavailable" });

      const job = makeJob({ params: metricsParams() });
      await runBundle({ config, coreV1, job });

      const failed = records.filter((r) => r.type === "metrics_text" && r.ok === false);
      expect(failed.some((r) => r.error?.includes("non-200"))).toBe(true);
    });

    it("fetch timeout writes timeout error record", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({
        namespace: "default",
        name: "p1",
        annotations: { "prometheus.io/scrape": "true", "prometheus.io/port": "9090" },
      });
      setupPodList([pod]);

      const abortError = new Error("aborted");
      abortError.name = "AbortError";
      (fetch as any).mockRejectedValue(abortError);

      const job = makeJob({ params: metricsParams() });
      await runBundle({ config, coreV1, job });

      const errRecords = records.filter((r) => r.type === "metrics_text" && r.ok === false);
      expect(errRecords.some((r) => r.error?.includes("timeout"))).toBe(true);
    });

    it("fetch error writes fetch_failed record", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({
        namespace: "default",
        name: "p1",
        annotations: { "prometheus.io/scrape": "true", "prometheus.io/port": "9090" },
      });
      setupPodList([pod]);
      (fetch as any).mockRejectedValue(new Error("ECONNREFUSED"));

      const job = makeJob({ params: metricsParams() });
      await runBundle({ config, coreV1, job });

      const errRecords = records.filter((r) => r.type === "metrics_text" && r.ok === false);
      expect(errRecords.some((r) => r.error === "fetch_failed")).toBe(true);
    });

    it("maxMetricsPods exceeded throws HttpError 400", async () => {
      makeWriter();
      const pods = Array.from({ length: 3 }, (_, i) =>
        createMockPod({
          namespace: "default",
          name: `p${i}`,
          annotations: { "prometheus.io/scrape": "true", "prometheus.io/port": "9090" },
        })
      );
      setupPodList(pods);

      const job = makeJob({
        params: metricsParams({
          limits: { ...metricsParams().limits, maxMetricsPods: 2 },
        }),
      });

      await expect(runBundle({ config, coreV1, job })).rejects.toMatchObject({
        statusCode: 400,
        message: expect.stringContaining("maxMetricsPods exceeded"),
      });
    });

    it("metrics disabled: skips collection", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({
        namespace: "default",
        name: "p1",
        annotations: { "prometheus.io/scrape": "true", "prometheus.io/port": "9090" },
      });
      setupPodList([pod]);
      setupPodLogs("");
      (listEventsNamespaced as any).mockResolvedValue({ items: [] });

      const job = makeJob(); // metrics disabled by default in makeParams
      await runBundle({ config, coreV1, job });

      expect(fetch).not.toHaveBeenCalled();
      expect(records.filter((r) => r.type === "metrics_text").length).toBe(0);
    });

    it("isMetricsAnnotated: no scrape annotation returns disabled", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({
        namespace: "default",
        name: "p1",
        annotations: { "prometheus.io/port": "9090" },
      });
      setupPodList([pod]);

      const job = makeJob({ params: metricsParams() });
      await runBundle({ config, coreV1, job });

      const skipped = records.filter((r) => r.type === "metrics_text" && r.skipped === true);
      expect(skipped.length).toBe(1);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("isMetricsAnnotated: scrape != 'true' returns disabled", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({
        namespace: "default",
        name: "p1",
        annotations: { "prometheus.io/scrape": "false", "prometheus.io/port": "9090" },
      });
      setupPodList([pod]);

      const job = makeJob({ params: metricsParams() });
      await runBundle({ config, coreV1, job });

      const skipped = records.filter((r) => r.type === "metrics_text" && r.skipped === true);
      expect(skipped.length).toBe(1);
    });

    it("isMetricsAnnotated: no port returns disabled", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({
        namespace: "default",
        name: "p1",
        annotations: { "prometheus.io/scrape": "true" },
      });
      setupPodList([pod]);

      const job = makeJob({ params: metricsParams() });
      await runBundle({ config, coreV1, job });

      const skipped = records.filter((r) => r.type === "metrics_text" && r.skipped === true);
      expect(skipped.length).toBe(1);
    });

    it("isMetricsAnnotated: invalid port returns disabled", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({
        namespace: "default",
        name: "p1",
        annotations: { "prometheus.io/scrape": "true", "prometheus.io/port": "abc" },
      });
      setupPodList([pod]);

      const job = makeJob({ params: metricsParams() });
      await runBundle({ config, coreV1, job });

      const skipped = records.filter((r) => r.type === "metrics_text" && r.skipped === true);
      expect(skipped.length).toBe(1);
    });

    it("isMetricsAnnotated: port <= 0 returns disabled", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({
        namespace: "default",
        name: "p1",
        annotations: { "prometheus.io/scrape": "true", "prometheus.io/port": "0" },
      });
      setupPodList([pod]);

      const job = makeJob({ params: metricsParams() });
      await runBundle({ config, coreV1, job });

      const skipped = records.filter((r) => r.type === "metrics_text" && r.skipped === true);
      expect(skipped.length).toBe(1);
    });

    it("isMetricsAnnotated: custom path annotation", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({
        namespace: "default",
        name: "p1",
        annotations: {
          "prometheus.io/scrape": "true",
          "prometheus.io/port": "9090",
          "prometheus.io/path": "/custom/metrics",
        },
      });
      setupPodList([pod]);
      (fetch as any).mockResolvedValue({ ok: true, status: 200, text: async () => "data\n" });

      const job = makeJob({ params: metricsParams() });
      await runBundle({ config, coreV1, job });

      const ok = records.filter((r) => r.type === "metrics_text" && r.ok === true);
      expect(ok.length).toBe(1);
      expect(ok[0].path).toBe("/custom/metrics");
    });

    it("isMetricsAnnotated: path not starting with / uses /metrics", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({
        namespace: "default",
        name: "p1",
        annotations: {
          "prometheus.io/scrape": "true",
          "prometheus.io/port": "9090",
          "prometheus.io/path": "no-leading-slash",
        },
      });
      setupPodList([pod]);
      (fetch as any).mockResolvedValue({ ok: true, status: 200, text: async () => "data\n" });

      const job = makeJob({ params: metricsParams() });
      await runBundle({ config, coreV1, job });

      const ok = records.filter((r) => r.type === "metrics_text" && r.ok === true);
      expect(ok[0].path).toBe("/metrics");
    });

    it("isMetricsAnnotated: empty path uses /metrics", async () => {
      const { records } = makeWriter();
      const pod = createMockPod({
        namespace: "default",
        name: "p1",
        annotations: {
          "prometheus.io/scrape": "true",
          "prometheus.io/port": "9090",
          "prometheus.io/path": "  ",
        },
      });
      setupPodList([pod]);
      (fetch as any).mockResolvedValue({ ok: true, status: 200, text: async () => "data\n" });

      const job = makeJob({ params: metricsParams() });
      await runBundle({ config, coreV1, job });

      const ok = records.filter((r) => r.type === "metrics_text" && r.ok === true);
      expect(ok[0].path).toBe("/metrics");
    });

    it("mapWithConcurrency: respects concurrency limit", async () => {
      const { records } = makeWriter();
      let concurrent = 0;
      let maxConcurrent = 0;

      const pods = Array.from({ length: 6 }, (_, i) =>
        createMockPod({
          namespace: "default",
          name: `p${i}`,
          annotations: { "prometheus.io/scrape": "true", "prometheus.io/port": "9090" },
        })
      );
      setupPodList(pods);

      (fetch as any).mockImplementation(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
        return { ok: true, status: 200, text: async () => "data" };
      });

      const job = makeJob({
        params: metricsParams({
          limits: { ...metricsParams().limits, metricsConcurrency: 2 },
        }),
      });
      await runBundle({ config, coreV1, job });

      expect(maxConcurrent).toBeLessThanOrEqual(2);
    });

    it("mixed annotated and non-annotated pods", async () => {
      const { records } = makeWriter();
      const annotatedPod = createMockPod({
        namespace: "default",
        name: "annotated",
        annotations: { "prometheus.io/scrape": "true", "prometheus.io/port": "9090" },
      });
      const plainPod = createMockPod({ namespace: "default", name: "plain" });
      setupPodList([annotatedPod, plainPod]);
      (fetch as any).mockResolvedValue({ ok: true, status: 200, text: async () => "data\n" });

      const job = makeJob({ params: metricsParams() });
      await runBundle({ config, coreV1, job });

      const okRecords = records.filter((r) => r.type === "metrics_text" && r.ok === true);
      const skippedRecords = records.filter((r) => r.type === "metrics_text" && r.skipped === true);
      expect(okRecords.length).toBe(1);
      expect(skippedRecords.length).toBe(1);
    });
  });
});
