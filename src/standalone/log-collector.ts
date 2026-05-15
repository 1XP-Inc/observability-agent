import type { NdjsonGzipWriter } from "../bundle-writer";
import { parseLogLine, shouldExcludeLine, parseLineTimeMs } from "../log-utils";
import { isoNow } from "../util";
import type { ServiceDef, StandaloneNormalizedRequest } from "./types";
import { tailLines } from "./file-tail";
import { readJournalLines } from "./journal-reader";

type ParsedLine = { ts?: string; msg: string };

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

function userJournalErrorMessage(reason: string, err: any): string | undefined {
  if (reason === "journal_permission_denied") {
    return "permission denied reading user journal; add observability_agent to systemd-journal and restart OA";
  }
  if (reason === "journal_user_not_found" || reason === "journal_user_invalid") {
    return err?.message;
  }
  if (reason === "journalctl_not_found") {
    return "journalctl not found";
  }
  return err?.stderr?.trim() || err?.message;
}

function filterLines(
  rawLines: string[],
  excludePatterns: string[],
  absStartMs?: number,
  absEndMs?: number,
): ParsedLine[] {
  const result: ParsedLine[] = [];
  for (const line of rawLines) {
    if (!line.length) continue;
    const parsed = parseLogLine(line, true);
    if (absStartMs != null && absEndMs != null) {
      const t = parseLineTimeMs(parsed.ts);
      if (t != null && (t < absStartMs || t > absEndMs)) continue;
    }
    if (shouldExcludeLine(parsed.msg, excludePatterns)) continue;
    result.push(parsed);
  }
  return result;
}

export async function collectStandaloneLogs(params: {
  writer: NdjsonGzipWriter;
  services: ServiceDef[];
  req: StandaloneNormalizedRequest;
}): Promise<void> {
  const { writer, services, req } = params;

  const absStartMs = req.timeWindow.kind === "absolute" ? Date.parse(req.timeWindow.start) : undefined;
  const absEndMs = req.timeWindow.kind === "absolute" ? Date.parse(req.timeWindow.end) : undefined;
  const excludePatterns = req.include.logs.excludePatterns;

  let totalLines = 0;

  for (const svc of services) {
    // --- File logs ---
    if (svc.logs && svc.logs.length > 0) {
      for (const logPath of svc.logs) {
        const budget = req.limits.maxTotalLogLines - totalLines;
        if (budget <= 0) return;

        let rawLines: string[];
        try {
          rawLines = await tailLines(logPath, budget);
        } catch (err: any) {
          await writer.writeRecord({
            type: "log",
            service: svc.name,
            file: logPath,
            ts: isoNow(),
            skipped: true,
            reason: err?.code === "ENOENT" ? "file_not_found" : "read_error",
            error: err?.message,
          });
          continue;
        }

        const filtered = filterLines(rawLines, excludePatterns, absStartMs, absEndMs);
        for (const parsed of filtered) {
          totalLines++;
          if (totalLines > req.limits.maxTotalLogLines) return;

          await writer.writeRecord({
            type: "log",
            service: svc.name,
            file: logPath,
            ts: parsed.ts,
            line: parsed.msg,
          });
        }
      }
    }

    // --- Journal logs ---
    if (svc.journal) {
      const budget = req.limits.maxTotalLogLines - totalLines;
      if (budget <= 0) return;

      let rawLines: string[];
      try {
        rawLines = await readJournalLines({
          unit: svc.journal,
          journalScope: journalScope(svc),
          journalUser: svc.journalUser,
          maxLines: budget,
          sinceSeconds: req.timeWindow.kind === "relative" ? req.timeWindow.sinceSeconds : undefined,
          sinceTime: req.timeWindow.kind === "absolute" ? req.timeWindow.start : undefined,
          untilTime: req.timeWindow.kind === "absolute" ? req.timeWindow.end : undefined,
        });
      } catch (err: any) {
        const reason = journalErrorReason(err);
        if (journalScope(svc) === "user") {
          await writer.writeRecord({
            type: "log_error",
            ...journalRecordBase(svc),
            ts: isoNow(),
            reason,
            error: userJournalErrorMessage(reason, err),
          });
        } else {
          await writer.writeRecord({
            type: "log",
            service: svc.name,
            journal: svc.journal,
            ts: isoNow(),
            skipped: true,
            reason,
            error: err?.stderr?.trim() || err?.message,
          });
        }
        continue;
      }

      const filtered = filterLines(rawLines, excludePatterns, absStartMs, absEndMs);
      if (filtered.length === 0 && journalScope(svc) === "user") {
        await writer.writeRecord({
          type: "log",
          ...journalRecordBase(svc),
          ts: "--",
          line: "No entries --",
        });
        continue;
      }
      for (const parsed of filtered) {
        totalLines++;
        if (totalLines > req.limits.maxTotalLogLines) return;

        await writer.writeRecord({
          type: "log",
          ...journalRecordBase(svc),
          ts: parsed.ts,
          line: parsed.msg,
        });
      }
    }
  }
}
