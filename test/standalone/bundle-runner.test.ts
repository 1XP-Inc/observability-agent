import { vi } from "vitest";

vi.mock("../../src/bundle-writer", () => ({
  createNdjsonGzipWriter: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  default: {
    mkdir: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ size: 999 })),
  },
}));

vi.mock("../../src/standalone/log-collector", () => ({
  collectStandaloneLogs: vi.fn(async () => {}),
}));

vi.mock("../../src/standalone/metrics-collector", () => ({
  collectStandaloneMetrics: vi.fn(async () => {}),
}));

import { runStandaloneBundle } from "../../src/standalone/bundle-runner";
import { createNdjsonGzipWriter } from "../../src/bundle-writer";
import { collectStandaloneLogs } from "../../src/standalone/log-collector";
import { collectStandaloneMetrics } from "../../src/standalone/metrics-collector";
import fs from "node:fs/promises";
import { createMockConfig } from "../helpers";
import type { BundleJob } from "../../src/types";
import type { ServiceDef, StandaloneNormalizedRequest } from "../../src/standalone/types";

const services: ServiceDef[] = [
  { name: "solana-validator", logs: ["/var/log/solana/validator.log"], metrics: "http://localhost:9090/metrics" },
  { name: "rpc-node", logs: ["/var/log/solana/rpc.log"] },
];

function makeReq(overrides?: Partial<StandaloneNormalizedRequest>): StandaloneNormalizedRequest {
  return {
    timeWindow: { kind: "relative", sinceSeconds: 600 },
    target: { kind: "services", services: ["solana-validator"] },
    include: {
      logs: { enabled: true, tailLines: 100, excludePatterns: [] },
      metrics: { enabled: true },
    },
    limits: { maxTotalLogLines: 50_000, sinceSecondsMax: 3600, metricsTimeoutMs: 2000 },
    ...overrides,
  };
}

function makeJob(overrides?: Partial<BundleJob<StandaloneNormalizedRequest>>): BundleJob<StandaloneNormalizedRequest> {
  return {
    bundleId: "bnd_test456",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    params: makeReq(),
    ...overrides,
  };
}

function makeWriter() {
  const records: any[] = [];
  const writer = {
    writeRecord: vi.fn(async (r: any) => { records.push(r); }),
    finalize: vi.fn(async () => {}),
  };
  (createNdjsonGzipWriter as any).mockReturnValue(writer);
  return { writer, records };
}

describe("runStandaloneBundle", () => {
  const config = createMockConfig({ mode: "standalone", services });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates bundle directory", async () => {
    makeWriter();
    const job = makeJob();
    await runStandaloneBundle({ config, services, job });
    expect(fs.mkdir).toHaveBeenCalledWith(config.bundleDir, { recursive: true });
  });

  it("writes meta record first", async () => {
    const { records } = makeWriter();
    const job = makeJob();
    await runStandaloneBundle({ config, services, job });
    expect(records[0]).toMatchObject({
      type: "meta",
      bundleId: "bnd_test456",
    });
  });

  it("calls collectStandaloneLogs when logs enabled", async () => {
    makeWriter();
    const job = makeJob();
    await runStandaloneBundle({ config, services, job });
    expect(collectStandaloneLogs).toHaveBeenCalledOnce();
  });

  it("calls collectStandaloneMetrics when metrics enabled", async () => {
    makeWriter();
    const job = makeJob();
    await runStandaloneBundle({ config, services, job });
    expect(collectStandaloneMetrics).toHaveBeenCalledOnce();
  });

  it("skips logs when disabled", async () => {
    makeWriter();
    const job = makeJob({ params: makeReq({ include: { logs: { enabled: false, tailLines: 100, excludePatterns: [] }, metrics: { enabled: true } } }) });
    await runStandaloneBundle({ config, services, job });
    expect(collectStandaloneLogs).not.toHaveBeenCalled();
  });

  it("skips metrics when disabled", async () => {
    makeWriter();
    const job = makeJob({ params: makeReq({ include: { logs: { enabled: true, tailLines: 100, excludePatterns: [] }, metrics: { enabled: false } } }) });
    await runStandaloneBundle({ config, services, job });
    expect(collectStandaloneMetrics).not.toHaveBeenCalled();
  });

  it("resolves target services correctly", async () => {
    makeWriter();
    const job = makeJob({ params: makeReq({ target: { kind: "services", services: ["rpc-node"] } }) });
    await runStandaloneBundle({ config, services, job });

    const call = (collectStandaloneLogs as any).mock.calls[0][0];
    expect(call.services).toEqual([{ name: "rpc-node", logs: ["/var/log/solana/rpc.log"] }]);
  });

  it("resolves all services when target.kind is 'all'", async () => {
    makeWriter();
    const job = makeJob({
      params: makeReq({ target: { kind: "all" } }),
    });
    await runStandaloneBundle({ config, services, job });

    const call = (collectStandaloneLogs as any).mock.calls[0][0];
    expect(call.services).toEqual(services);
  });

  it("calls writer.finalize()", async () => {
    const { writer } = makeWriter();
    const job = makeJob();
    await runStandaloneBundle({ config, services, job });
    expect(writer.finalize).toHaveBeenCalledOnce();
  });

  it("sets job.artifactPath and job.artifactSizeBytes", async () => {
    makeWriter();
    const job = makeJob();
    await runStandaloneBundle({ config, services, job });
    expect(job.artifactPath).toContain("bnd_test456.ndjson.gz");
    expect(job.artifactSizeBytes).toBe(999);
  });
});
