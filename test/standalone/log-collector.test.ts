import { vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectStandaloneLogs } from "../../src/standalone/log-collector";
import type { StandaloneNormalizedRequest, ServiceDef } from "../../src/standalone/types";

function makeReq(overrides?: Partial<StandaloneNormalizedRequest>): StandaloneNormalizedRequest {
  return {
    timeWindow: { kind: "relative", sinceSeconds: 600 },
    target: { kind: "services", services: ["svc1"] },
    include: {
      logs: { enabled: true, tailLines: 100, excludePatterns: [] },
      metrics: { enabled: false },
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

function tmpLog(content: string): string {
  const p = path.join(os.tmpdir(), `log-col-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

describe("collectStandaloneLogs", () => {
  it("collects log lines from file", async () => {
    const logFile = tmpLog("2024-01-01T00:00:00Z hello\n2024-01-01T00:00:01Z world\n");
    const services: ServiceDef[] = [{ name: "svc1", logs: [logFile] }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    const logRecords = records.filter((r: any) => r.type === "log" && r.line);
    expect(logRecords.length).toBe(2);
    expect(logRecords[0]).toMatchObject({ type: "log", service: "svc1", file: logFile, ts: "2024-01-01T00:00:00Z", line: "hello" });
    expect(logRecords[1]).toMatchObject({ line: "world" });

    fs.unlinkSync(logFile);
  });

  it("skips services with no logs configured", async () => {
    const services: ServiceDef[] = [{ name: "svc1" }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    expect(records.length).toBe(0);
  });

  it("skips services with empty logs array", async () => {
    const services: ServiceDef[] = [{ name: "svc1", logs: [] }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    expect(records.length).toBe(0);
  });

  it("writes skipped record for non-existent file", async () => {
    const services: ServiceDef[] = [{ name: "svc1", logs: ["/tmp/nonexistent-log-file-12345.log"] }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    expect(records.length).toBe(1);
    expect(records[0]).toMatchObject({
      type: "log",
      service: "svc1",
      skipped: true,
      reason: "file_not_found",
    });
  });

  it("applies excludePatterns", async () => {
    const logFile = tmpLog("2024-01-01T00:00:00Z healthcheck ok\n2024-01-01T00:00:01Z important msg\n");
    const services: ServiceDef[] = [{ name: "svc1", logs: [logFile] }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({
      writer,
      services,
      req: makeReq({ include: { logs: { enabled: true, tailLines: 100, excludePatterns: ["healthcheck"] }, metrics: { enabled: false } } }),
    });

    const logRecords = records.filter((r: any) => r.type === "log" && r.line);
    expect(logRecords.length).toBe(1);
    expect(logRecords[0].line).toBe("important msg");

    fs.unlinkSync(logFile);
  });

  it("respects maxTotalLogLines limit", async () => {
    const lines = Array.from({ length: 10 }, (_, i) => `2024-01-01T00:00:0${i}Z line-${i}`).join("\n") + "\n";
    const logFile = tmpLog(lines);
    const services: ServiceDef[] = [{ name: "svc1", logs: [logFile] }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({
      writer,
      services,
      req: makeReq({ limits: { maxTotalLogLines: 5, sinceSecondsMax: 3600, metricsTimeoutMs: 2000 } }),
    });

    const logRecords = records.filter((r: any) => r.type === "log" && r.line);
    expect(logRecords.length).toBe(5);

    fs.unlinkSync(logFile);
  });

  it("filters by absolute time window", async () => {
    const logFile = tmpLog(
      "2024-01-01T00:00:00Z before\n" +
      "2024-01-01T12:00:00Z inside\n" +
      "2024-01-02T00:00:01Z after\n"
    );
    const services: ServiceDef[] = [{ name: "svc1", logs: [logFile] }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({
      writer,
      services,
      req: makeReq({
        timeWindow: { kind: "absolute", start: "2024-01-01T06:00:00Z", end: "2024-01-02T00:00:00Z" },
      }),
    });

    const logRecords = records.filter((r: any) => r.type === "log" && r.line);
    expect(logRecords.length).toBe(1);
    expect(logRecords[0].line).toBe("inside");

    fs.unlinkSync(logFile);
  });

  it("includes lines without timestamp in absolute mode", async () => {
    const logFile = tmpLog("no-timestamp-line\n");
    const services: ServiceDef[] = [{ name: "svc1", logs: [logFile] }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({
      writer,
      services,
      req: makeReq({
        timeWindow: { kind: "absolute", start: "2024-01-01T00:00:00Z", end: "2024-01-02T00:00:00Z" },
      }),
    });

    const logRecords = records.filter((r: any) => r.type === "log" && r.line);
    expect(logRecords.length).toBe(1);

    fs.unlinkSync(logFile);
  });

  it("handles multiple services and files", async () => {
    const f1 = tmpLog("2024-01-01T00:00:00Z svc1-line\n");
    const f2 = tmpLog("2024-01-01T00:00:00Z svc2-line\n");
    const services: ServiceDef[] = [
      { name: "svc1", logs: [f1] },
      { name: "svc2", logs: [f2] },
    ];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    const logRecords = records.filter((r: any) => r.type === "log" && r.line);
    expect(logRecords.length).toBe(2);
    expect(logRecords[0].service).toBe("svc1");
    expect(logRecords[1].service).toBe("svc2");

    fs.unlinkSync(f1);
    fs.unlinkSync(f2);
  });

  it("writes read_error for non-ENOENT errors", async () => {
    // Use a directory path — reading a directory with readline throws a non-ENOENT error
    const dirPath = os.tmpdir();
    const services: ServiceDef[] = [{ name: "svc1", logs: [dirPath] }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    expect(records.length).toBe(1);
    expect(records[0]).toMatchObject({
      type: "log",
      service: "svc1",
      skipped: true,
      reason: "read_error",
    });
  });

  it("skips empty lines", async () => {
    const logFile = tmpLog("2024-01-01T00:00:00Z line1\n\n2024-01-01T00:00:01Z line2\n");
    const services: ServiceDef[] = [{ name: "svc1", logs: [logFile] }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    const logRecords = records.filter((r: any) => r.type === "log" && r.line);
    expect(logRecords.length).toBe(2);

    fs.unlinkSync(logFile);
  });
});
