import { vi } from "vitest";

vi.mock("undici", () => ({
  fetch: vi.fn(),
}));

import { fetch } from "undici";
import { collectStandaloneMetrics } from "../../src/standalone/metrics-collector";
import type { StandaloneNormalizedRequest, ServiceDef } from "../../src/standalone/types";
import { MAX_METRICS_BODY_BYTES } from "../../src/metrics-body";

function makeReq(overrides?: Partial<StandaloneNormalizedRequest>): StandaloneNormalizedRequest {
  return {
    timeWindow: { kind: "relative", sinceSeconds: 600 },
    target: { kind: "services", services: ["svc1"] },
    include: {
      logs: { enabled: false, excludePatterns: [] },
      metrics: { enabled: true },
    },
    limits: { maxTotalLogLines: 50_000, sinceSecondsMax: 3600, metricsTimeoutMs: 2000 },
    ...overrides,
  };
}

function makeWriter() {
  const records: any[] = [];
  return {
    writer: {
      writeRecord: vi.fn(async (r: any) => { records.push(r); }),
      finalize: vi.fn(async () => {}),
    },
    records,
  };
}

function streamResponse(chunks: Uint8Array[]) {
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  };
}

function textResponse(text: string, init: { ok?: boolean; status?: number } = {}) {
  return {
    ...streamResponse([new TextEncoder().encode(text)]),
    ok: init.ok ?? true,
    status: init.status ?? 200,
  };
}

describe("collectStandaloneMetrics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches metrics from service URL and writes ok record", async () => {
    const services: ServiceDef[] = [{ name: "svc1", metrics: "http://localhost:9090/metrics" }];
    const { writer, records } = makeWriter();
    (fetch as any).mockResolvedValue(textResponse("counter 42\n"));

    await collectStandaloneMetrics({ writer, services, req: makeReq() });

    const ok = records.filter((r: any) => r.type === "metrics_text" && r.ok === true);
    expect(ok.length).toBe(1);
    expect(ok[0]).toMatchObject({
      service: "svc1",
      url: "http://localhost:9090/metrics",
      ok: true,
      content: "counter 42\n",
    });
  });

  it("continues to allow private/internal metrics URLs", async () => {
    const services: ServiceDef[] = [{ name: "svc1", metrics: "http://10.0.0.5:9090/metrics" }];
    const { writer, records } = makeWriter();
    (fetch as any).mockResolvedValue(textResponse("counter 42\n"));

    await collectStandaloneMetrics({ writer, services, req: makeReq() });

    expect(fetch).toHaveBeenCalledWith("http://10.0.0.5:9090/metrics", expect.any(Object));
    expect(records[0]).toMatchObject({
      service: "svc1",
      url: "http://10.0.0.5:9090/metrics",
      ok: true,
    });
  });

  it("writes skipped record for service without metrics URL", async () => {
    const services: ServiceDef[] = [{ name: "svc1" }];
    const { writer, records } = makeWriter();

    await collectStandaloneMetrics({ writer, services, req: makeReq() });

    expect(records.length).toBe(1);
    expect(records[0]).toMatchObject({
      type: "metrics_text",
      service: "svc1",
      skipped: true,
      reason: "no_metrics_url",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("writes error record for non-200 response", async () => {
    const services: ServiceDef[] = [{ name: "svc1", metrics: "http://localhost:9090/metrics" }];
    const { writer, records } = makeWriter();
    (fetch as any).mockResolvedValue(textResponse("unavailable", { ok: false, status: 503 }));

    await collectStandaloneMetrics({ writer, services, req: makeReq() });

    const err = records.filter((r: any) => r.type === "metrics_text" && r.ok === false);
    expect(err.length).toBe(1);
    expect(err[0].error).toContain("non-200");
  });

  it("writes timeout error for AbortError", async () => {
    const services: ServiceDef[] = [{ name: "svc1", metrics: "http://localhost:9090/metrics" }];
    const { writer, records } = makeWriter();
    const abortErr = new Error("aborted");
    abortErr.name = "AbortError";
    (fetch as any).mockRejectedValue(abortErr);

    await collectStandaloneMetrics({ writer, services, req: makeReq() });

    const err = records.filter((r: any) => r.type === "metrics_text" && r.ok === false);
    expect(err.length).toBe(1);
    expect(err[0].error).toContain("timeout");
  });

  it("writes fetch_failed for other errors", async () => {
    const services: ServiceDef[] = [{ name: "svc1", metrics: "http://localhost:9090/metrics" }];
    const { writer, records } = makeWriter();
    (fetch as any).mockRejectedValue(new Error("ECONNREFUSED"));

    await collectStandaloneMetrics({ writer, services, req: makeReq() });

    const err = records.filter((r: any) => r.type === "metrics_text" && r.ok === false);
    expect(err.length).toBe(1);
    expect(err[0].error).toBe("fetch_failed: ECONNREFUSED");
  });

  it("stops streaming when metrics response exceeds the 10MB limit", async () => {
    const services: ServiceDef[] = [{ name: "svc1", metrics: "http://localhost:9090/metrics" }];
    const { writer, records } = makeWriter();
    const resp = streamResponse([
      new Uint8Array(MAX_METRICS_BODY_BYTES),
      new Uint8Array(1),
    ]);
    (fetch as any).mockResolvedValue(resp);

    await collectStandaloneMetrics({ writer, services, req: makeReq() });

    const err = records.filter((r: any) => r.type === "metrics_text" && r.ok === false);
    expect(err.length).toBe(1);
    expect(err[0].error).toContain("response_too_large");
  });

  it("handles multiple services", async () => {
    const services: ServiceDef[] = [
      { name: "svc1", metrics: "http://localhost:9090/metrics" },
      { name: "svc2" },
      { name: "svc3", metrics: "http://localhost:9091/metrics" },
    ];
    const { writer, records } = makeWriter();
    (fetch as any).mockResolvedValue(textResponse("data\n"));

    await collectStandaloneMetrics({ writer, services, req: makeReq() });

    expect(records.length).toBe(3);
    const ok = records.filter((r: any) => r.ok === true);
    const skipped = records.filter((r: any) => r.skipped === true);
    expect(ok.length).toBe(2);
    expect(skipped.length).toBe(1);
    expect(skipped[0].service).toBe("svc2");
  });
});
