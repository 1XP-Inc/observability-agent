import type { CoreV1Api } from "@kubernetes/client-node";
import type { NdjsonGzipWriter } from "../bundle-writer";
import { HttpError } from "../http-error";
import type { LogFetchResult, NormalizedBundleRequest, PodRef } from "./types";
import { isoNow } from "../util";
import { readPodLog } from "./compat";
import { parseLogLine, shouldExcludeLine, parseLineTimeMs } from "../log-utils";

export async function collectLogsForContainer(params: {
  coreV1: CoreV1Api;
  namespace: string;
  pod: string;
  container: string;
  sinceSeconds?: number;
  sinceTime?: string;
  tailLines: number;
  timestamps: boolean;
  previous: boolean;
}): Promise<LogFetchResult> {
  try {
    const text = await readPodLog({
      coreV1: params.coreV1,
      namespace: params.namespace,
      name: params.pod,
      container: params.container,
      sinceSeconds: params.sinceSeconds,
      sinceTime: params.sinceTime,
      tailLines: params.tailLines,
      timestamps: params.timestamps,
      previous: params.previous,
    });
    return { ok: true, text };
  } catch (err: any) {
    const status =
      err?.statusCode ??
      err?.response?.statusCode ??
      err?.response?.status ??
      err?.body?.code;
    const msg = typeof err?.message === "string" ? err.message.toLowerCase() : "";

    if (
      params.previous &&
      (status === 400 ||
        status === 404 ||
        msg.includes("previous terminated container") ||
        msg.includes("previous log") ||
        msg.includes("no previous"))
    ) {
      return { ok: false, skipped: true, reason: "no_previous_container" };
    }

    throw err;
  }
}

function processLogLines(params: {
  text: string;
  timestamps: boolean;
  timeWindow: NormalizedBundleRequest["timeWindow"];
  absStartMs?: number;
  absEndMs?: number;
  excludePatterns: string[];
}): Array<{ ts?: string; msg: string }> {
  const lines = params.text.split("\n").filter((l) => l.length);
  const out: Array<{ ts?: string; msg: string }> = [];
  for (const line of lines) {
    const parsed = parseLogLine(line, params.timestamps);
    if (params.timeWindow.kind === "absolute") {
      const t = parseLineTimeMs(parsed.ts);
      if (t == null) continue;
      if (t < params.absStartMs! || t > params.absEndMs!) continue;
    }
    if (shouldExcludeLine(line, params.excludePatterns)) continue;
    out.push(parsed);
  }
  return out;
}

export async function collectLogs(params: {
  coreV1: CoreV1Api;
  writer: NdjsonGzipWriter;
  pods: PodRef[];
  req: NormalizedBundleRequest;
}): Promise<void> {
  const { coreV1, writer, pods, req } = params;

  const containerCounts = pods.map((p) => p.containers.length);
  const perContainerMultiplier = req.include.logs.previous ? 2 : 1;
  const expectedMax =
    containerCounts.reduce((acc, n) => acc + n, 0) * req.include.logs.tailLines * perContainerMultiplier;

  if (expectedMax > req.limits.maxTotalLogLines) {
    throw new HttpError(400, "maxTotalLogLines would be exceeded by requested tailLines/containers", {
      expectedMax,
      maxTotalLogLines: req.limits.maxTotalLogLines,
    });
  }

  const relSinceSeconds = req.timeWindow.kind === "relative" ? req.timeWindow.sinceSeconds : undefined;
  const absStartMs = req.timeWindow.kind === "absolute" ? Date.parse(req.timeWindow.start) : undefined;
  const absEndMs = req.timeWindow.kind === "absolute" ? Date.parse(req.timeWindow.end) : undefined;

  for (const p of pods) {
    for (const c of p.containers) {
      // current logs
      const cur = await collectLogsForContainer({
        coreV1,
        namespace: p.namespace,
        pod: p.name,
        container: c,
        sinceSeconds: relSinceSeconds,
        sinceTime: req.timeWindow.kind === "absolute" ? req.timeWindow.start : undefined,
        tailLines: req.include.logs.tailLines,
        timestamps: req.include.logs.timestamps,
        previous: false,
      });
      const curLines = processLogLines({
        text: cur.ok ? cur.text : "",
        timestamps: req.include.logs.timestamps,
        timeWindow: req.timeWindow,
        absStartMs,
        absEndMs,
        excludePatterns: req.include.logs.excludePatterns,
      });
      for (const parsed of curLines) {
        await writer.writeRecord({
          type: "log",
          namespace: p.namespace,
          pod: p.name,
          container: c,
          ts: parsed.ts,
          line: parsed.msg,
        });
      }

      if (req.include.logs.previous) {
        const prev = await collectLogsForContainer({
          coreV1,
          namespace: p.namespace,
          pod: p.name,
          container: c,
          sinceSeconds: relSinceSeconds,
          sinceTime: req.timeWindow.kind === "absolute" ? req.timeWindow.start : undefined,
          tailLines: req.include.logs.tailLines,
          timestamps: req.include.logs.timestamps,
          previous: true,
        });
        if (!prev.ok && prev.skipped) {
          await writer.writeRecord({
            type: "log",
            namespace: p.namespace,
            pod: p.name,
            container: c,
            ts: isoNow(),
            previous: true,
            skipped: true,
            reason: prev.reason,
          });
        } else {
          const prevLines = processLogLines({
            text: prev.ok ? prev.text : "",
            timestamps: req.include.logs.timestamps,
            timeWindow: req.timeWindow,
            absStartMs,
            absEndMs,
            excludePatterns: req.include.logs.excludePatterns,
          });
          for (const parsed of prevLines) {
            await writer.writeRecord({
              type: "log",
              namespace: p.namespace,
              pod: p.name,
              container: c,
              ts: parsed.ts,
              previous: true,
              line: parsed.msg,
            });
          }
        }
      }
    }
  }
}
