import type { NdjsonGzipWriter } from "../bundle-writer";
import { parseLogLine, shouldExcludeLine, parseLineTimeMs } from "../log-utils";
import { isoNow } from "../util";
import type { ServiceDef, StandaloneNormalizedRequest } from "./types";
import { tailLines } from "./file-tail";
import { readJournalLines } from "./journal-reader";

export async function collectStandaloneLogs(params: {
  writer: NdjsonGzipWriter;
  services: ServiceDef[];
  req: StandaloneNormalizedRequest;
}): Promise<void> {
  const { writer, services, req } = params;

  const absStartMs = req.timeWindow.kind === "absolute" ? Date.parse(req.timeWindow.start) : undefined;
  const absEndMs = req.timeWindow.kind === "absolute" ? Date.parse(req.timeWindow.end) : undefined;

  let totalLines = 0;

  for (const svc of services) {
    // --- File logs ---
    if (svc.logs && svc.logs.length > 0) {
      for (const logPath of svc.logs) {
        let lines: string[];
        try {
          lines = await tailLines(logPath, req.include.logs.tailLines);
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

        for (const line of lines) {
          if (!line.length) continue;

          const parsed = parseLogLine(line, true);

          if (req.timeWindow.kind === "absolute") {
            const t = parseLineTimeMs(parsed.ts);
            if (t == null) {
              // No timestamp — include the line as-is
            } else if (t < absStartMs! || t > absEndMs!) {
              continue;
            }
          }

          if (shouldExcludeLine(parsed.msg, req.include.logs.excludePatterns)) continue;

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
      let lines: string[];
      try {
        lines = await readJournalLines({
          unit: svc.journal,
          maxLines: req.include.logs.tailLines,
          sinceSeconds: req.timeWindow.kind === "relative" ? req.timeWindow.sinceSeconds : undefined,
          sinceTime: req.timeWindow.kind === "absolute" ? req.timeWindow.start : undefined,
          untilTime: req.timeWindow.kind === "absolute" ? req.timeWindow.end : undefined,
        });
      } catch (err: any) {
        const reason = err?.code === "ENOENT" ? "journalctl_not_found" : "journal_read_error";
        await writer.writeRecord({
          type: "log",
          service: svc.name,
          journal: svc.journal,
          ts: isoNow(),
          skipped: true,
          reason,
          error: err?.message,
        });
        continue;
      }

      for (const line of lines) {
        if (!line.length) continue;

        const parsed = parseLogLine(line, true);

        if (req.timeWindow.kind === "absolute") {
          const t = parseLineTimeMs(parsed.ts);
          if (t == null) {
            // No timestamp — include the line as-is
          } else if (t < absStartMs! || t > absEndMs!) {
            continue;
          }
        }

        if (shouldExcludeLine(parsed.msg, req.include.logs.excludePatterns)) continue;

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
