import type { NdjsonGzipWriter } from "../bundle-writer";
import { parseLogLine, shouldExcludeLine, shouldIncludeLine, parseLineTimeMs } from "../log-utils";
import { isoNow } from "../util";
import type { ServiceDef, StandaloneNormalizedRequest } from "./types";
import { tailLines } from "./file-tail";
import { readJournalLines } from "./journal-reader";

const SOURCE_CANDIDATE_MULTIPLIER = 5;
const MAX_SOURCE_CANDIDATE_LINES = 100_000;

type ParsedLine = { ts?: string; msg: string; sortMs?: number };

type LogSourceBase = {
  service: string;
  file?: string;
  journal?: string;
  journalScope?: string;
  journalUser?: string;
};

type SourceSummary = LogSourceBase & {
  sourceCandidateLimit: number;
  rawLogRecords: number;
  matchedLogRecords: number;
  returnedLogRecords: number;
  sourceLineLimited: boolean;
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

function filterLines(rawLines: string[], filters: LogFilters): ParsedLine[] {
  const result: ParsedLine[] = [];
  for (const line of rawLines) {
    if (!line.length) continue;
    const parsed = parseLogLine(line, true);
    const sortMs = parseLineTimeMs(parsed.ts);
    if (filters.startMs != null && filters.endMs != null && sortMs != null) {
      if (sortMs < filters.startMs || sortMs > filters.endMs) continue;
    }
    if (!shouldIncludeLine(parsed.msg, filters.includePatterns)) continue;
    if (shouldExcludeLine(parsed.msg, filters.excludePatterns)) continue;
    result.push({ ...parsed, sortMs });
  }
  return result;
}

function timeBounds(req: StandaloneNormalizedRequest): Pick<LogFilters, "startMs" | "endMs"> {
  if (req.timeWindow.kind === "absolute") {
    return {
      startMs: Date.parse(req.timeWindow.start),
      endMs: Date.parse(req.timeWindow.end),
    };
  }

  const endMs = Date.now();
  return {
    startMs: endMs - req.timeWindow.sinceSeconds * 1000,
    endMs,
  };
}

function logSortMs(candidate: LogCandidate): number {
  return candidate.sortMs ?? Number.NEGATIVE_INFINITY;
}

function newestFirst(a: LogCandidate, b: LogCandidate): number {
  const byTime = logSortMs(b) - logSortMs(a);
  if (byTime !== 0) return byTime;
  return b.sequence - a.sequence;
}

function outputOrder(a: LogCandidate, b: LogCandidate): number {
  const byTime = logSortMs(a) - logSortMs(b);
  if (byTime !== 0) return byTime;
  return a.sequence - b.sequence;
}

function sourceCandidateLimit(maxTotalLogLines: number): number {
  return Math.min(maxTotalLogLines * SOURCE_CANDIDATE_MULTIPLIER, MAX_SOURCE_CANDIDATE_LINES);
}

export async function collectStandaloneLogs(params: {
  writer: NdjsonGzipWriter;
  services: ServiceDef[];
  req: StandaloneNormalizedRequest;
}): Promise<void> {
  const { writer, services, req } = params;

  const filters: LogFilters = {
    ...timeBounds(req),
    includePatterns: req.include.logs.includePatterns ?? [],
    excludePatterns: req.include.logs.excludePatterns ?? [],
  };
  const sourceCandidateLimitValue = sourceCandidateLimit(req.limits.maxTotalLogLines);
  const sourceStates: SourceState[] = [];
  const sideRecords: Array<Record<string, unknown>> = [];
  const candidates: LogCandidate[] = [];
  let nextSourceIndex = 0;
  let nextSequence = 0;

  function addSource(base: LogSourceBase, initial?: Partial<SourceSummary>): SourceState {
    const state: SourceState = {
      key: String(nextSourceIndex++),
      summary: {
        ...base,
        sourceCandidateLimit: sourceCandidateLimitValue,
        rawLogRecords: 0,
        matchedLogRecords: 0,
        returnedLogRecords: 0,
        sourceLineLimited: false,
        ...initial,
      },
    };
    sourceStates.push(state);
    return state;
  }

  function addCandidates(state: SourceState, base: LogSourceBase, rawLines: string[]): void {
    const filtered = filterLines(rawLines, filters);
    state.summary.rawLogRecords = rawLines.length;
    state.summary.matchedLogRecords = filtered.length;
    state.summary.sourceLineLimited = rawLines.length >= sourceCandidateLimitValue;

    for (const parsed of filtered) {
      candidates.push({
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
  }

  for (const svc of services) {
    if (svc.logs && svc.logs.length > 0) {
      for (const logPath of svc.logs) {
        const base = { service: svc.name, file: logPath };
        const state = addSource(base);

        let rawLines: string[];
        try {
          rawLines = await tailLines(logPath, sourceCandidateLimitValue);
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

        addCandidates(state, base, rawLines);
      }
    }

    if (svc.journal) {
      const base = journalRecordBase(svc) as LogSourceBase;
      const state = addSource(base);

      let rawLines: string[];
      try {
        rawLines = await readJournalLines({
          unit: svc.journal,
          journalScope: journalScope(svc),
          journalUser: svc.journalUser,
          maxLines: sourceCandidateLimitValue,
          sinceSeconds: req.timeWindow.kind === "relative" ? req.timeWindow.sinceSeconds : undefined,
          sinceTime: req.timeWindow.kind === "absolute" ? req.timeWindow.start : undefined,
          untilTime: req.timeWindow.kind === "absolute" ? req.timeWindow.end : undefined,
        });
      } catch (err: any) {
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

      if (rawLines.length === 0 && journalScope(svc) === "user") {
        sideRecords.push({
          type: "log",
          ...journalRecordBase(svc),
          ts: "--",
          line: "No entries --",
        });
        continue;
      }

      addCandidates(state, base, rawLines);
    }
  }

  const selected = [...candidates]
    .sort(newestFirst)
    .slice(0, req.limits.maxTotalLogLines)
    .sort(outputOrder);
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

  const lineLimited = candidates.length > selected.length;
  const hasSourceLimit = sourceStates.some((state) => state.summary.sourceLineLimited);
  const hasSkippedSource = sourceStates.some((state) => state.summary.skipped);
  if (lineLimited || hasSourceLimit || hasSkippedSource) {
    await writer.writeRecord({
      type: "log_summary",
      ts: isoNow(),
      maxTotalLogLines: req.limits.maxTotalLogLines,
      sourceCandidateLimit: sourceCandidateLimitValue,
      lineLimited: lineLimited || hasSourceLimit,
      matchedLogRecords: candidates.length,
      returnedLogRecords: selected.length,
      sources: sourceStates.map((state) => state.summary),
    });
  }
}
