import { fetch } from "undici";
import type { NdjsonGzipWriter } from "../bundle-writer";
import { HttpError } from "../http-error";
import type { NormalizedBundleRequest, PodRef } from "./types";
import { isoNow, mapWithConcurrency } from "../util";
import { MAX_METRICS_BODY_BYTES, ResponseTooLargeError, readResponseTextWithLimit } from "../metrics-body";

export function isMetricsAnnotated(pod: PodRef): { enabled: boolean; port?: number; path: string } {
  const scrape = pod.annotations["prometheus.io/scrape"];
  if (scrape !== "true") return { enabled: false, path: "/metrics" };

  const portStr = pod.annotations["prometheus.io/port"];
  if (!portStr) return { enabled: false, path: "/metrics" };

  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port) || Number.isNaN(port) || port <= 0) return { enabled: false, path: "/metrics" };

  const p = pod.annotations["prometheus.io/path"]?.trim();
  const metricsPath = p && p.startsWith("/") && !p.includes("..") && !p.includes("?") && !p.includes("#") ? p : "/metrics";
  return { enabled: true, port, path: metricsPath };
}

export async function collectMetrics(params: {
  writer: NdjsonGzipWriter;
  pods: PodRef[];
  req: NormalizedBundleRequest;
}): Promise<void> {
  const { writer, pods, req } = params;

  const candidates = pods
    .map((p) => ({ pod: p, ann: isMetricsAnnotated(p) }))
    .filter((x) => x.ann.enabled);

  if (candidates.length > req.limits.maxMetricsPods) {
    throw new HttpError(400, `maxMetricsPods exceeded (${candidates.length} > ${req.limits.maxMetricsPods})`);
  }

  const timeoutMs = req.limits.metricsTimeoutMs;
  const concurrency = req.limits.metricsConcurrency;

  // Record skipped for non-annotated pods.
  for (const p of pods) {
    const ann = isMetricsAnnotated(p);
    if (!ann.enabled) {
      await writer.writeRecord({
        type: "metrics_text",
        namespace: p.namespace,
        pod: p.name,
        ts: isoNow(),
        skipped: true,
        reason: "annotation_missing",
      });
    }
  }

  await mapWithConcurrency(candidates, concurrency, async ({ pod, ann }) => {
    const ts = isoNow();
    if (!pod.podIP) {
      await writer.writeRecord({
        type: "metrics_text",
        namespace: pod.namespace,
        pod: pod.name,
        ts,
        ok: false,
        error: "podIP_missing",
      });
      return;
    }

    const url = `http://${pod.podIP}:${ann.port}${ann.path}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { signal: ac.signal });
      let text: string;
      try {
        text = await readResponseTextWithLimit(resp, MAX_METRICS_BODY_BYTES);
      } catch (err) {
        if (!(err instanceof ResponseTooLargeError)) throw err;
        await writer.writeRecord({
          type: "metrics_text",
          namespace: pod.namespace,
          pod: pod.name,
          podIP: pod.podIP,
          port: ann.port,
          path: ann.path,
          ts,
          ok: false,
          error: err.message,
        });
        return;
      }
      if (!resp.ok) {
        await writer.writeRecord({
          type: "metrics_text",
          namespace: pod.namespace,
          pod: pod.name,
          podIP: pod.podIP,
          port: ann.port,
          path: ann.path,
          ts,
          ok: false,
          error: `non-200 (${resp.status})`,
        });
        return;
      }

      await writer.writeRecord({
        type: "metrics_text",
        namespace: pod.namespace,
        pod: pod.name,
        podIP: pod.podIP,
        port: ann.port,
        path: ann.path,
        ts,
        ok: true,
        content: text,
      });
    } catch (err: any) {
      const msg = typeof err?.name === "string" && err.name === "AbortError" ? `timeout after ${timeoutMs}ms` : "fetch_failed";
      await writer.writeRecord({
        type: "metrics_text",
        namespace: pod.namespace,
        pod: pod.name,
        podIP: pod.podIP,
        port: ann.port,
        path: ann.path,
        ts,
        ok: false,
        error: msg,
      });
    } finally {
      clearTimeout(timer);
    }
  });
}
