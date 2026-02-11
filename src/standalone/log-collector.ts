import type { NdjsonGzipWriter } from "../bundle-writer";
import { parseLogLine, shouldExcludeLine, parseLineTimeMs } from "../log-collector";
import { isoNow } from "../util";
import type { ServiceDef, StandaloneNormalizedRequest } from "./types";
import { tailLines } from "./file-tail";

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
    if (!svc.logs || svc.logs.length === 0) continue;

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
            // No timestamp — include the line as-is (standalone logs may not have timestamps)
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
}
