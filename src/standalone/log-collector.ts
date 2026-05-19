import type { NdjsonGzipWriter } from "../bundle-writer";
import { parseLogLine, shouldExcludeLine, shouldIncludeLine, parseLineTimeMs } from "../log-utils";
import { isoNow } from "../util";
import type { ServiceDef, StandaloneNormalizedRequest } from "./types";
import { streamJournalLines } from "./journal-reader";
import { tailLines } from "./file-tail";

type ParsedLine = { ts?: string; msg: string; sortMs?: number };

type LogSourceBase = {
  service: string;
  file?: string;
  journal?: string;
  journalScope?: string;
  journalUser?: string;
};

type SourceSummary = LogSourceBase & {
  rawLogRecords: number;
  matchedLogRecords: number;
  returnedLogRecords: number;
  skipped?: boolean;
  reason?: string;
  error?: string;
};

type SourceState = {
  key: string;
  summary: SourceSummary;
};

type LogCandidate = {
  sourceKey: string;
  sequence: number;
  sortMs?: number;
  record: Record<string, unknown>;
};

type LogFilters = {
  includePatterns: string[];
  excludePatterns: string[];
  startMs?: number;
  endMs?: number;
};

class TopLogCandidates {
  private heap: LogCandidate[] = [];

  constructor(private readonly maxSize: number) {}

  add(candidate: LogCandidate): void {
    if (this.maxSize <= 0) return;
    if (this.heap.length < this.maxSize) {
      this.heap.push(candidate);
      this.siftUp(this.heap.length - 1);
      return;
    }
    if (compareCandidateRank(candidate, this.heap[0]) <= 0) return;
    this.heap[0] = candidate;
    this.siftDown(0);
  }

  values(): LogCandidate[] {
    return [...this.heap];
  }

  removeSource(sourceKey: string): void {
    const next = this.heap.filter((candidate) => candidate.sourceKey !== sourceKey);
    if (next.length === this.heap.length) return;
    this.heap = next;
    for (let i = Math.floor(this.heap.length / 2) - 1; i >= 0; i--) {
      this.siftDown(i);
    }
  }

  private siftUp(index: number): void {
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareCandidateRank(this.heap[index], this.heap[parent]) >= 0) break;
      [this.heap[index], this.heap[parent]] = [this.heap[parent], this.heap[index]];
      index = parent;
    }
  }

  private siftDown(index: number): void {
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.heap.length && compareCandidateRank(this.heap[left], this.heap[smallest]) < 0) {
        smallest = left;
      }
      if (right < this.heap.length && compareCandidateRank(this.heap[right], this.heap[smallest]) < 0) {
        smallest = right;
      }
      if (smallest === index) break;
      [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
      index = smallest;
    }
  }
}

function journalScope(svc: ServiceDef): "system" | "user" {
  return svc.journalScope ?? "system";
}

function journalRecordBase(svc: ServiceDef): Record<string, unknown> {
  const base: Record<string, unknown> = {
    service: svc.name,
    journal: svc.journal,
  };
  if (journalScope(svc) === "user") {
    base.journalScope = "user";
    base.journalUser = svc.journalUser;
  }
  return base;
}

function journalErrorReason(err: any): string {
  if (err?.code === "ENOENT") return "journalctl_not_found";
  if (err?.code === "EACCES") return "journal_permission_denied";
  if (err?.code === "ENOUSER") return "journal_user_not_found";
  if (err?.code === "EINVAL") return "journal_user_invalid";
  return "journal_read_error";
}

function fallbackErrorMessage(err: any): string {
  if (typeof err?.stderr === "string" && err.stderr.trim()) return err.stderr.trim();
  if (typeof err?.message === "string" && err.message.trim()) return err.message;
  if (err == null) return "unknown error";
  if (typeof err === "string" && err.trim()) return err;
  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}") return json;
  } catch {
    // Fall through to String() conversion.
  }
  try {
    const text = String(err);
    if (text && text !== "[object Object]") return text;
  } catch {
    // Fall through to the fixed fallback.
  }
  return "unknown error";
}

function userJournalErrorMessage(reason: string, err: any): string {
  if (reason === "journal_permission_denied") {
    return "permission denied reading user journal; add the OA process user to systemd-journal and restart OA";
  }
  if (reason === "journal_user_not_found" || reason === "journal_user_invalid") {
    return fallbackErrorMessage(err);
  }
  if (reason === "journalctl_not_found") {
    return "journalctl not found";
  }
  return fallbackErrorMessage(err);
}

function filterLine(line: string, filters: LogFilters): ParsedLine | undefined {
  if (!line.length) return undefined;
  const parsed = parseLogLine(line, true);
  const sortMs = parseLineTimeMs(parsed.ts);
  if (filters.startMs != null && filters.endMs != null && sortMs != null) {
    if (sortMs < filters.startMs || sortMs > filters.endMs) return undefined;
  }
  if (!shouldIncludeLine(parsed.msg, filters.includePatterns)) return undefined;
  if (shouldExcludeLine(parsed.msg, filters.excludePatterns)) return undefined;
  return { ...parsed, sortMs };
}

function timeBounds(timeWindow: NonNullable<StandaloneNormalizedRequest["timeWindow"]>): Pick<LogFilters, "startMs" | "endMs"> {
  if (timeWindow.kind === "absolute") {
    return {
      startMs: Date.parse(timeWindow.start),
      endMs: Date.parse(timeWindow.end),
    };
  }

  const endMs = Date.now();
  return {
    startMs: endMs - timeWindow.sinceSeconds * 1000,
    endMs,
  };
}

function compareCandidateRank(a: LogCandidate, b: LogCandidate): number {
  if (a.sortMs != null && b.sortMs != null) {
    const byTime = a.sortMs - b.sortMs;
    if (byTime !== 0) return byTime;
  }
  return a.sequence - b.sequence;
}

export async function collectStandaloneLogs(params: {
  writer: NdjsonGzipWriter;
  services: ServiceDef[];
  req: StandaloneNormalizedRequest;
}): Promise<void> {
  const { writer, services, req } = params;

  const textFilters: LogFilters = {
    includePatterns: req.include.logs.includePatterns ?? [],
    excludePatterns: req.include.logs.excludePatterns ?? [],
  };
  const journalTimeFilters: Pick<LogFilters, "startMs" | "endMs"> | undefined =
    req.timeWindow ? timeBounds(req.timeWindow) : undefined;
  const fixedSinceTime = journalTimeFilters?.startMs != null ? new Date(journalTimeFilters.startMs).toISOString() : undefined;
  const fixedUntilTime = journalTimeFilters?.endMs != null ? new Date(journalTimeFilters.endMs).toISOString() : undefined;
  const sourceStates: SourceState[] = [];
  const sideRecords: Array<Record<string, unknown>> = [];
  const candidates = new TopLogCandidates(req.limits.maxTotalLogLines);
  let nextSourceIndex = 0;
  let nextSequence = 0;

  function addSource(base: LogSourceBase, initial?: Partial<SourceSummary>): SourceState {
    const state: SourceState = {
      key: String(nextSourceIndex++),
      summary: {
        ...base,
        rawLogRecords: 0,
        matchedLogRecords: 0,
        returnedLogRecords: 0,
        ...initial,
      },
    };
    sourceStates.push(state);
    return state;
  }

  function addLine(state: SourceState, base: LogSourceBase, line: string, sourceFilters: LogFilters): void {
    if (!line.length) return;
    state.summary.rawLogRecords++;
    const parsed = filterLine(line, sourceFilters);
    if (!parsed) return;
    state.summary.matchedLogRecords++;
    candidates.add({
      sourceKey: state.key,
      sequence: nextSequence++,
      sortMs: parsed.sortMs,
      record: {
        type: "log",
        ...base,
        ts: parsed.ts,
        line: parsed.msg,
      },
    });
  }

  for (const svc of services) {
    if (svc.logs && svc.logs.length > 0) {
      for (const logPath of svc.logs) {
        const base = { service: svc.name, file: logPath };
        const state = addSource(base);

        try {
          const lines = await tailLines(logPath, req.include.logs.tailLines);
          for (const line of lines) {
            addLine(state, base, line, textFilters);
          }
        } catch (err: any) {
          const reason = err?.code === "ENOENT" ? "file_not_found" : "read_error";
          const error = err?.message;
          sideRecords.push({
            type: "log",
            ...base,
            ts: isoNow(),
            skipped: true,
            reason,
            error,
          });
          state.summary.skipped = true;
          state.summary.reason = reason;
          state.summary.error = error;
          continue;
        }
      }
    }

    if (svc.journal) {
      const base = journalRecordBase(svc) as LogSourceBase;
      const state = addSource(base);
      const sourceFilters: LogFilters = {
        ...textFilters,
        ...(journalTimeFilters ?? {}),
      };

      try {
        const journalParams: Parameters<typeof streamJournalLines>[0] = {
          unit: svc.journal,
          journalScope: journalScope(svc),
          journalUser: svc.journalUser,
        };
        if (req.timeWindow) {
          journalParams.sinceTime = fixedSinceTime;
          journalParams.untilTime = fixedUntilTime;
        } else {
          journalParams.maxLines = req.include.logs.tailLines;
        }
        await streamJournalLines(journalParams, (line) => addLine(state, base, line, sourceFilters));
      } catch (err: any) {
        candidates.removeSource(state.key);
        state.summary.rawLogRecords = 0;
        state.summary.matchedLogRecords = 0;
        const reason = journalErrorReason(err);
        const error = journalScope(svc) === "user"
          ? userJournalErrorMessage(reason, err)
          : err?.stderr?.trim() || err?.message;
        if (journalScope(svc) === "user") {
          sideRecords.push({
            type: "log_error",
            ...journalRecordBase(svc),
            ts: isoNow(),
            reason,
            error,
          });
        } else {
          sideRecords.push({
            type: "log",
            ...base,
            ts: isoNow(),
            skipped: true,
            reason,
            error,
          });
        }
        state.summary.skipped = true;
        state.summary.reason = reason;
        state.summary.error = error;
        continue;
      }

      if (state.summary.rawLogRecords === 0 && journalScope(svc) === "user") {
        sideRecords.push({
          type: "log",
          ...journalRecordBase(svc),
          ts: "--",
          line: "No entries --",
        });
        continue;
      }
    }
  }

  const selected = candidates.values().sort(compareCandidateRank);
  const returnedBySource = new Map<string, number>();
  for (const candidate of selected) {
    returnedBySource.set(candidate.sourceKey, (returnedBySource.get(candidate.sourceKey) ?? 0) + 1);
  }
  for (const state of sourceStates) {
    state.summary.returnedLogRecords = returnedBySource.get(state.key) ?? 0;
  }

  for (const record of sideRecords) {
    await writer.writeRecord(record);
  }
  for (const candidate of selected) {
    await writer.writeRecord(candidate.record);
  }

  const matchedLogRecords = sourceStates.reduce((total, state) => total + state.summary.matchedLogRecords, 0);
  const lineLimited = matchedLogRecords > selected.length;
  if (sourceStates.length > 0) {
    await writer.writeRecord({
      type: "log_summary",
      ts: isoNow(),
      maxTotalLogLines: req.limits.maxTotalLogLines,
      lineLimited,
      matchedLogRecords,
      returnedLogRecords: selected.length,
      sources: sourceStates.map((state) => state.summary),
    });
  }
}
