import type { NdjsonGzipWriter } from "../bundle-writer";
import { parseLogLine, shouldExcludeLine, parseLineTimeMs } from "../log-utils";
import { isoNow } from "../util";
import type { ServiceDef, StandaloneNormalizedRequest } from "./types";
import { tailLines } from "./file-tail";
import { readJournalLines } from "./journal-reader";

type ParsedLine = { ts?: string; msg: string };

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

const MAX_READ_MULTIPLIER = 10;

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

        const maxRead = budget * MAX_READ_MULTIPLIER;
        let filtered: ParsedLine[] = [];
        let fileError: any = null;

        // Pass 1: read budget lines
        let rawLines: string[];
        try {
          rawLines = await tailLines(logPath, budget);
        } catch (err: any) {
          fileError = err;
          rawLines = [];
        }

        if (!fileError) {
          filtered = filterLines(rawLines, excludePatterns, absStartMs, absEndMs);

          // Pass 2: if excludes reduced count, estimate clean rate and read once more
          if (filtered.length < budget && rawLines.length >= budget && filtered.length > 0) {
            const cleanRate = filtered.length / rawLines.length;
            const needed = Math.min(Math.ceil(budget / cleanRate * 1.2), maxRead);
            try {
              rawLines = await tailLines(logPath, needed);
            } catch (err: any) {
              fileError = err;
            }
            if (!fileError) {
              filtered = filterLines(rawLines, excludePatterns, absStartMs, absEndMs);
            }
          }
        }

        if (fileError) {
          await writer.writeRecord({
            type: "log",
            service: svc.name,
            file: logPath,
            ts: isoNow(),
            skipped: true,
            reason: fileError?.code === "ENOENT" ? "file_not_found" : "read_error",
            error: fileError?.message,
          });
          continue;
        }

        // Take the most recent `budget` clean lines
        const toWrite = filtered.length > budget ? filtered.slice(-budget) : filtered;
        for (const parsed of toWrite) {
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

      const maxRead = budget * MAX_READ_MULTIPLIER;
      let filtered: ParsedLine[] = [];
      let journalError: any = null;

      // Pass 1: read budget lines
      let rawLines: string[];
      try {
        rawLines = await readJournalLines({
          unit: svc.journal,
          maxLines: budget,
          sinceSeconds: req.timeWindow.kind === "relative" ? req.timeWindow.sinceSeconds : undefined,
          sinceTime: req.timeWindow.kind === "absolute" ? req.timeWindow.start : undefined,
          untilTime: req.timeWindow.kind === "absolute" ? req.timeWindow.end : undefined,
        });
      } catch (err: any) {
        journalError = err;
        rawLines = [];
      }

      if (!journalError) {
        filtered = filterLines(rawLines, excludePatterns, absStartMs, absEndMs);

        // Pass 2: if excludes reduced count, estimate clean rate and read once more
        if (filtered.length < budget && rawLines.length >= budget && filtered.length > 0) {
          const cleanRate = filtered.length / rawLines.length;
          const needed = Math.min(Math.ceil(budget / cleanRate * 1.2), maxRead);
          try {
            rawLines = await readJournalLines({
              unit: svc.journal,
              maxLines: needed,
              sinceSeconds: req.timeWindow.kind === "relative" ? req.timeWindow.sinceSeconds : undefined,
              sinceTime: req.timeWindow.kind === "absolute" ? req.timeWindow.start : undefined,
              untilTime: req.timeWindow.kind === "absolute" ? req.timeWindow.end : undefined,
            });
          } catch (err: any) {
            journalError = err;
          }
          if (!journalError) {
            filtered = filterLines(rawLines, excludePatterns, absStartMs, absEndMs);
          }
        }
      }

      if (journalError) {
        const reason = journalError?.code === "ENOENT" ? "journalctl_not_found" : "journal_read_error";
        await writer.writeRecord({
          type: "log",
          service: svc.name,
          journal: svc.journal,
          ts: isoNow(),
          skipped: true,
          reason,
          error: journalError?.message,
        });
        continue;
      }

      const toWrite = filtered.length > budget ? filtered.slice(-budget) : filtered;
      for (const parsed of toWrite) {
        totalLines++;
        if (totalLines > req.limits.maxTotalLogLines) return;

        await writer.writeRecord({
          type: "log",
          service: svc.name,
          journal: svc.journal,
          ts: parsed.ts,
          line: parsed.msg,
        });
      }
    }
  }
}
