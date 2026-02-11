import { fetch } from "undici";
import type { NdjsonGzipWriter } from "../bundle-writer";
import { isoNow } from "../util";
import type { ServiceDef, StandaloneNormalizedRequest } from "./types";

export async function collectStandaloneMetrics(params: {
  writer: NdjsonGzipWriter;
  services: ServiceDef[];
  req: StandaloneNormalizedRequest;
}): Promise<void> {
  const { writer, services, req } = params;
  const timeoutMs = req.limits.metricsTimeoutMs;

  for (const svc of services) {
    const ts = isoNow();

    if (!svc.metrics) {
      await writer.writeRecord({
        type: "metrics_text",
        service: svc.name,
        ts,
        skipped: true,
        reason: "no_metrics_url",
      });
      continue;
    }

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const MAX_BODY = 10 * 1024 * 1024;
      const resp = await fetch(svc.metrics, { signal: ac.signal });
      const text = await resp.text();
      if (text.length > MAX_BODY) {
        await writer.writeRecord({
          type: "metrics_text",
          service: svc.name,
          url: svc.metrics,
          ts,
          ok: false,
          error: `response_too_large (${text.length} bytes)`,
        });
        continue;
      }
      if (!resp.ok) {
        await writer.writeRecord({
          type: "metrics_text",
          service: svc.name,
          url: svc.metrics,
          ts,
          ok: false,
          error: `non-200 (${resp.status})`,
        });
        continue;
      }

      await writer.writeRecord({
        type: "metrics_text",
        service: svc.name,
        url: svc.metrics,
        ts,
        ok: true,
        content: text,
      });
    } catch (err: any) {
      const msg =
        typeof err?.name === "string" && err.name === "AbortError"
          ? `timeout after ${timeoutMs}ms`
          : `fetch_failed: ${err?.message ?? "unknown"}`;
      await writer.writeRecord({
        type: "metrics_text",
        service: svc.name,
        url: svc.metrics,
        ts,
        ok: false,
        error: msg,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
