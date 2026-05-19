import { vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectStandaloneLogs } from "../../src/standalone/log-collector";
import type { StandaloneNormalizedRequest, ServiceDef } from "../../src/standalone/types";

// Mock journal-reader for journal tests
vi.mock("../../src/standalone/journal-reader", () => ({
  readJournalLines: vi.fn(async () => []),
  streamJournalLines: vi.fn(async () => 0),
}));

import { streamJournalLines } from "../../src/standalone/journal-reader";
const mockStreamJournalLines = vi.mocked(streamJournalLines);

function mockJournalLines(lines: string[]) {
  mockStreamJournalLines.mockImplementation(async (_params, onLine) => {
    for (const line of lines) {
      await onLine(line);
    }
    return lines.length;
  });
}

function makeReq(overrides?: Partial<StandaloneNormalizedRequest>): StandaloneNormalizedRequest {
  const base: StandaloneNormalizedRequest = {
    timeWindow: { kind: "absolute", start: "2020-01-01T00:00:00Z", end: "2030-01-01T00:00:00Z" },
    target: { kind: "services", services: ["svc1"] },
    include: {
      logs: { enabled: true, includePatterns: [], excludePatterns: [] },
      metrics: { enabled: false },
    },
    limits: { maxTotalLogLines: 50_000, sinceSecondsMax: 3600, metricsTimeoutMs: 2000 },
  };
  return {
    ...base,
    ...overrides,
    include: {
      logs: { ...base.include.logs, ...overrides?.include?.logs },
      metrics: { ...base.include.metrics, ...overrides?.include?.metrics },
    },
    limits: { ...base.limits, ...overrides?.limits },
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

function logLineRecords(records: any[]) {
  return records.filter((r: any) => r.type === "log" && r.line);
}

function logSummary(records: any[]) {
  return records.find((r: any) => r.type === "log_summary");
}

function tmpLog(content: string): string {
  const p = path.join(os.tmpdir(), `log-col-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

beforeEach(() => {
  mockStreamJournalLines.mockReset();
  mockJournalLines([]);
});

describe("collectStandaloneLogs", () => {
  it("collects log lines from file", async () => {
    const logFile = tmpLog("2024-01-01T00:00:00Z hello\n2024-01-01T00:00:01Z world\n");
    const services: ServiceDef[] = [{ name: "svc1", logs: [logFile] }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    const logRecords = logLineRecords(records);
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

    expect(records[0]).toMatchObject({
      type: "log",
      service: "svc1",
      skipped: true,
      reason: "file_not_found",
    });
    expect(logSummary(records)).toMatchObject({
      type: "log_summary",
      matchedLogRecords: 0,
      returnedLogRecords: 0,
      sources: [expect.objectContaining({ service: "svc1", skipped: true, reason: "file_not_found" })],
    });
  });

  it("applies excludePatterns", async () => {
    const logFile = tmpLog("2024-01-01T00:00:00Z healthcheck ok\n2024-01-01T00:00:01Z important msg\n");
    const services: ServiceDef[] = [{ name: "svc1", logs: [logFile] }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({
      writer,
      services,
      req: makeReq({ include: { logs: { enabled: true, excludePatterns: ["healthcheck"] }, metrics: { enabled: false } } }),
    });

    const logRecords = logLineRecords(records);
    expect(logRecords.length).toBe(1);
    expect(logRecords[0].line).toBe("important msg");

    fs.unlinkSync(logFile);
  });

  it("applies includePatterns before the final line limit", async () => {
    const logFile = tmpLog(
      "2024-01-01T00:00:01Z error matched\n" +
      "2024-01-01T00:00:02Z info second\n" +
      "2024-01-01T00:00:03Z info third\n" +
      "2024-01-01T00:00:04Z info fourth\n" +
      "2024-01-01T00:00:05Z info fifth\n" +
      "2024-01-01T00:00:06Z info sixth\n"
    );
    const services: ServiceDef[] = [{ name: "svc1", logs: [logFile] }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({
      writer,
      services,
      req: makeReq({
        include: { logs: { enabled: true, includePatterns: ["error"] }, metrics: { enabled: false } },
        limits: { maxTotalLogLines: 1, sinceSecondsMax: 3600, metricsTimeoutMs: 2000 },
      }),
    });

    expect(logLineRecords(records).map((r: any) => r.line)).toEqual(["error matched"]);

    fs.unlinkSync(logFile);
  });

  it("finds absolute-window file matches that are not near the end of the file", async () => {
    const logFile = tmpLog(
      "2024-01-01T00:00:00Z before\n" +
      "2024-01-01T12:00:00Z inside\n" +
      "2024-01-02T00:00:01Z after-1\n" +
      "2024-01-02T00:00:02Z after-2\n" +
      "2024-01-02T00:00:03Z after-3\n" +
      "2024-01-02T00:00:04Z after-4\n" +
      "2024-01-02T00:00:05Z after-5\n"
    );
    const services: ServiceDef[] = [{ name: "svc1", logs: [logFile] }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({
      writer,
      services,
      req: makeReq({
        timeWindow: { kind: "absolute", start: "2024-01-01T06:00:00Z", end: "2024-01-02T00:00:00Z" },
        limits: { maxTotalLogLines: 1, sinceSecondsMax: 3600, metricsTimeoutMs: 2000 },
      }),
    });

    expect(logLineRecords(records).map((r: any) => r.line)).toEqual(["inside"]);
    expect(logSummary(records)).toMatchObject({
      type: "log_summary",
      lineLimited: false,
      matchedLogRecords: 1,
      returnedLogRecords: 1,
    });

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

    const logRecords = logLineRecords(records);
    expect(logRecords.length).toBe(5);
    expect(logRecords.map((r: any) => r.line)).toEqual(["line-5", "line-6", "line-7", "line-8", "line-9"]);
    expect(logSummary(records)).toMatchObject({
      type: "log_summary",
      lineLimited: true,
      matchedLogRecords: 10,
      returnedLogRecords: 5,
    });

    fs.unlinkSync(logFile);
  });

  it("filters file logs by relative sinceSeconds", async () => {
    const oldTs = new Date(Date.now() - 1_200_000).toISOString();
    const recentTs = new Date(Date.now() - 60_000).toISOString();
    const logFile = tmpLog(`${oldTs} old\n${recentTs} recent\n`);
    const services: ServiceDef[] = [{ name: "svc1", logs: [logFile] }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({
      writer,
      services,
      req: makeReq({ timeWindow: { kind: "relative", sinceSeconds: 600 } }),
    });

    expect(logLineRecords(records).map((r: any) => r.line)).toEqual(["recent"]);

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

    const logRecords = logLineRecords(records);
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

    const logRecords = logLineRecords(records);
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

    const logRecords = logLineRecords(records);
    expect(logRecords.length).toBe(2);
    expect(logRecords[0].service).toBe("svc1");
    expect(logRecords[1].service).toBe("svc2");

    fs.unlinkSync(f1);
    fs.unlinkSync(f2);
  });

  it("writes read_error for non-ENOENT errors", async () => {
    // /dev/null/fake triggers "Not a directory" error from tail (non-ENOENT)
    const services: ServiceDef[] = [{ name: "svc1", logs: ["/dev/null/fake"] }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    expect(records[0]).toMatchObject({
      type: "log",
      service: "svc1",
      skipped: true,
      reason: "read_error",
    });
    expect(logSummary(records)).toMatchObject({
      type: "log_summary",
      sources: [expect.objectContaining({ service: "svc1", skipped: true, reason: "read_error" })],
    });
  });

  it("skips empty lines", async () => {
    const logFile = tmpLog("2024-01-01T00:00:00Z line1\n\n2024-01-01T00:00:01Z line2\n");
    const services: ServiceDef[] = [{ name: "svc1", logs: [logFile] }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    const logRecords = logLineRecords(records);
    expect(logRecords.length).toBe(2);

    fs.unlinkSync(logFile);
  });

  // --- Journal log tests ---

  it("collects journal logs when journal is configured", async () => {
    mockJournalLines([
      "2024-01-15T10:30:00+0000 host nginx[123]: request received",
      "2024-01-15T10:30:01+0000 host nginx[123]: request completed",
    ]);
    const services: ServiceDef[] = [{ name: "svc1", journal: "nginx.service" }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    const logRecords = logLineRecords(records);
    expect(logRecords.length).toBe(2);
    expect(logRecords[0]).toMatchObject({
      type: "log",
      service: "svc1",
      journal: "nginx.service",
      line: "host nginx[123]: request received",
    });
  });

  it("collects user journal logs with scope metadata", async () => {
    mockJournalLines([
      "2026-05-15T03:45:01+0000 bera-beacond[123]: started",
    ]);
    const services: ServiceDef[] = [{
      name: "beacond",
      journal: "bera-beacond.service",
      journalScope: "user",
      journalUser: "ubuntu",
    }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    expect(mockStreamJournalLines).toHaveBeenCalledWith(expect.objectContaining({
      unit: "bera-beacond.service",
      journalScope: "user",
      journalUser: "ubuntu",
    }), expect.any(Function));
    expect(records[0]).toMatchObject({
      type: "log",
      service: "beacond",
      journal: "bera-beacond.service",
      journalScope: "user",
      journalUser: "ubuntu",
      ts: "2026-05-15T03:45:01+0000",
      line: "bera-beacond[123]: started",
    });
  });

  it("writes No entries only for successful empty user journal reads", async () => {
    mockJournalLines([]);
    const services: ServiceDef[] = [{
      name: "beacond",
      journal: "bera-beacond.service",
      journalScope: "user",
      journalUser: "ubuntu",
    }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    expect(records[0]).toMatchObject({
      type: "log",
      service: "beacond",
      journal: "bera-beacond.service",
      journalScope: "user",
      journalUser: "ubuntu",
      ts: "--",
      line: "No entries --",
    });
    expect(logSummary(records)).toMatchObject({
      type: "log_summary",
      lineLimited: false,
      matchedLogRecords: 0,
      returnedLogRecords: 0,
    });
  });

  it("writes only summary for empty system journal reads", async () => {
    mockJournalLines([]);
    const services: ServiceDef[] = [{ name: "svc1", journal: "nginx.service" }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    expect(logLineRecords(records)).toEqual([]);
    expect(logSummary(records)).toMatchObject({
      type: "log_summary",
      lineLimited: false,
      matchedLogRecords: 0,
      returnedLogRecords: 0,
    });
  });

  it("collects file and journal logs simultaneously", async () => {
    const logFile = tmpLog("2024-01-01T00:00:00Z file-line\n");
    mockJournalLines([
      "2024-01-15T10:30:00+0000 host unit[1]: journal-line",
    ]);
    const services: ServiceDef[] = [{ name: "svc1", logs: [logFile], journal: "app.service" }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    const logRecords = logLineRecords(records);
    expect(logRecords.length).toBe(2);
    expect(logRecords[0]).toMatchObject({ file: logFile, line: "file-line" });
    expect(logRecords[1]).toMatchObject({ journal: "app.service", line: "host unit[1]: journal-line" });

    fs.unlinkSync(logFile);
  });

  it("respects maxTotalLogLines across file and journal", async () => {
    const lines = Array.from({ length: 4 }, (_, i) => `2024-01-01T00:00:0${i}Z file-${i}`).join("\n") + "\n";
    const logFile = tmpLog(lines);
    mockJournalLines([
      "2024-01-15T10:30:00+0000 host unit[1]: journal-0",
      "2024-01-15T10:30:01+0000 host unit[1]: journal-1",
    ]);
    const services: ServiceDef[] = [{ name: "svc1", logs: [logFile], journal: "app.service" }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({
      writer,
      services,
      req: makeReq({ limits: { maxTotalLogLines: 5, sinceSecondsMax: 3600, metricsTimeoutMs: 2000 } }),
    });

    const logRecords = logLineRecords(records);
    expect(logRecords.length).toBe(5);
    expect(logRecords.map((r: any) => r.line)).toEqual([
      "file-1",
      "file-2",
      "file-3",
      "host unit[1]: journal-0",
      "host unit[1]: journal-1",
    ]);
    expect(logSummary(records)).toMatchObject({
      type: "log_summary",
      lineLimited: true,
      matchedLogRecords: 6,
      returnedLogRecords: 5,
    });

    fs.unlinkSync(logFile);
  });

  it("globally merges candidates before applying maxTotalLogLines", async () => {
    const f1 = tmpLog(
      "2024-01-01T00:00:00Z svc1-0\n" +
      "2024-01-01T00:00:01Z svc1-1\n" +
      "2024-01-01T00:00:02Z svc1-2\n" +
      "2024-01-01T00:00:03Z svc1-3\n" +
      "2024-01-01T00:00:04Z svc1-4\n"
    );
    const f2 = tmpLog("2024-01-01T00:00:10Z svc2-0\n2024-01-01T00:00:11Z svc2-1\n");
    const services: ServiceDef[] = [
      { name: "svc1", logs: [f1] },
      { name: "svc2", logs: [f2] },
    ];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({
      writer,
      services,
      req: makeReq({ limits: { maxTotalLogLines: 3, sinceSecondsMax: 3600, metricsTimeoutMs: 2000 } }),
    });

    expect(logLineRecords(records).map((r: any) => `${r.service}:${r.line}`)).toEqual([
      "svc1:svc1-4",
      "svc2:svc2-0",
      "svc2:svc2-1",
    ]);
    expect(logSummary(records)).toMatchObject({
      type: "log_summary",
      lineLimited: true,
      matchedLogRecords: 7,
      returnedLogRecords: 3,
      sources: expect.arrayContaining([
        expect.objectContaining({ service: "svc1", matchedLogRecords: 5, returnedLogRecords: 1 }),
        expect.objectContaining({ service: "svc2", matchedLogRecords: 2, returnedLogRecords: 2 }),
      ]),
    });

    fs.unlinkSync(f1);
    fs.unlinkSync(f2);
  });

  it("writes skipped record when journalctl is not found", async () => {
    const err = new Error("spawn journalctl ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockStreamJournalLines.mockRejectedValue(err);
    const services: ServiceDef[] = [{ name: "svc1", journal: "nginx.service" }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    expect(records[0]).toMatchObject({
      type: "log",
      service: "svc1",
      journal: "nginx.service",
      skipped: true,
      reason: "journalctl_not_found",
    });
    expect(logSummary(records)).toMatchObject({
      type: "log_summary",
      sources: [expect.objectContaining({ service: "svc1", skipped: true, reason: "journalctl_not_found" })],
    });
  });

  it("writes skipped record for journal read errors", async () => {
    const err = new Error("command failed") as NodeJS.ErrnoException;
    err.code = "EPERM";
    mockStreamJournalLines.mockRejectedValue(err);
    const services: ServiceDef[] = [{ name: "svc1", journal: "nginx.service" }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    expect(records[0]).toMatchObject({
      type: "log",
      service: "svc1",
      journal: "nginx.service",
      skipped: true,
      reason: "journal_read_error",
    });
    expect(logSummary(records)).toMatchObject({
      type: "log_summary",
      sources: [expect.objectContaining({ service: "svc1", skipped: true, reason: "journal_read_error" })],
    });
  });

  it("writes journal_permission_denied when EACCES", async () => {
    const err = new Error("not seeing messages from other users") as NodeJS.ErrnoException;
    err.code = "EACCES";
    mockStreamJournalLines.mockRejectedValue(err);
    const services: ServiceDef[] = [{ name: "svc1", journal: "nginx.service" }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    expect(records[0]).toMatchObject({
      type: "log",
      service: "svc1",
      journal: "nginx.service",
      skipped: true,
      reason: "journal_permission_denied",
    });
    expect(logSummary(records)).toMatchObject({
      type: "log_summary",
      sources: [expect.objectContaining({ service: "svc1", skipped: true, reason: "journal_permission_denied" })],
    });
  });

  it("writes log_error for user journal permission errors", async () => {
    const err = new Error("not seeing messages from other users") as NodeJS.ErrnoException;
    err.code = "EACCES";
    mockStreamJournalLines.mockRejectedValue(err);
    const services: ServiceDef[] = [{
      name: "beacond",
      journal: "bera-beacond.service",
      journalScope: "user",
      journalUser: "ubuntu",
    }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    expect(records[0]).toMatchObject({
      type: "log_error",
      service: "beacond",
      journal: "bera-beacond.service",
      journalScope: "user",
      journalUser: "ubuntu",
      reason: "journal_permission_denied",
      error: "permission denied reading user journal; add the OA process user to systemd-journal and restart OA",
    });
    expect(logSummary(records)).toMatchObject({
      type: "log_summary",
      sources: [expect.objectContaining({ service: "beacond", skipped: true, reason: "journal_permission_denied" })],
    });
  });

  it("does not write No entries when user journal lines are filtered out", async () => {
    mockJournalLines([
      "2026-05-15T03:45:01+0000 bera-beacond[123]: filtered",
    ]);
    const services: ServiceDef[] = [{
      name: "beacond",
      journal: "bera-beacond.service",
      journalScope: "user",
      journalUser: "ubuntu",
    }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({
      writer,
      services,
      req: makeReq({
        include: {
          logs: { enabled: true, excludePatterns: ["filtered"] },
          metrics: { enabled: false },
        },
      }),
    });

    expect(logLineRecords(records)).toEqual([]);
    expect(logSummary(records)).toMatchObject({
      type: "log_summary",
      lineLimited: false,
      matchedLogRecords: 0,
      returnedLogRecords: 0,
    });
  });

  it("writes string error for non-Error user journal failures", async () => {
    mockStreamJournalLines.mockRejectedValue("journal failed");
    const services: ServiceDef[] = [{
      name: "beacond",
      journal: "bera-beacond.service",
      journalScope: "user",
      journalUser: "ubuntu",
    }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    expect(records[0]).toMatchObject({
      type: "log_error",
      service: "beacond",
      journal: "bera-beacond.service",
      journalScope: "user",
      journalUser: "ubuntu",
      reason: "journal_read_error",
      error: "journal failed",
    });
  });

  it("writes log_error for unresolved user journal users", async () => {
    const err = new Error('journalUser "missing" was not found or is not a valid UID') as NodeJS.ErrnoException;
    err.code = "ENOUSER";
    mockStreamJournalLines.mockRejectedValue(err);
    const services: ServiceDef[] = [{
      name: "beacond",
      journal: "bera-beacond.service",
      journalScope: "user",
      journalUser: "missing",
    }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    expect(records[0]).toMatchObject({
      type: "log_error",
      service: "beacond",
      journal: "bera-beacond.service",
      journalScope: "user",
      journalUser: "missing",
      reason: "journal_user_not_found",
      error: 'journalUser "missing" was not found or is not a valid UID',
    });
  });

  it("filters journal logs by absolute time window", async () => {
    mockJournalLines([
      "2024-01-01T00:00:00+0000 host unit[1]: before",
      "2024-01-01T12:00:00+0000 host unit[1]: inside",
      "2024-01-02T00:00:01+0000 host unit[1]: after",
    ]);
    const services: ServiceDef[] = [{ name: "svc1", journal: "app.service" }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({
      writer,
      services,
      req: makeReq({
        timeWindow: { kind: "absolute", start: "2024-01-01T06:00:00Z", end: "2024-01-02T00:00:00Z" },
      }),
    });

    const logRecords = logLineRecords(records);
    expect(logRecords.length).toBe(1);
    expect(logRecords[0].line).toContain("inside");
  });

  it("includes journal lines without timestamp in absolute mode", async () => {
    mockJournalLines(["no-timestamp-line"]);
    const services: ServiceDef[] = [{ name: "svc1", journal: "app.service" }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({
      writer,
      services,
      req: makeReq({
        timeWindow: { kind: "absolute", start: "2024-01-01T00:00:00Z", end: "2024-01-02T00:00:00Z" },
      }),
    });

    const logRecords = logLineRecords(records);
    expect(logRecords.length).toBe(1);
  });

  it("skips journal when not configured", async () => {
    const services: ServiceDef[] = [{ name: "svc1" }];
    const { writer, records } = makeWriter();

    await collectStandaloneLogs({ writer, services, req: makeReq() });

    expect(records.length).toBe(0);
    expect(mockStreamJournalLines).not.toHaveBeenCalled();
  });
});
