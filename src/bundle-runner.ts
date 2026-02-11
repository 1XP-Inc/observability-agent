import fs from "node:fs/promises";
import path from "node:path";
import type { CoreV1Api } from "@kubernetes/client-node";
import { fetch } from "undici";
import type { OAConfig } from "./config";
import { createNdjsonGzipWriter } from "./bundle-writer";
import type { BundleJob, NormalizedBundleRequest } from "./types";
import { HttpError } from "./validate";
import { listEventsNamespaced, listPodsAllNamespaces, listPodsNamespaced, readPod, readPodLog } from "./k8s-compat";

type PodRef = {
  namespace: string;
  name: string;
  podIP?: string;
  annotations: Record<string, string>;
  labels: Record<string, string>;
  containers: string[];
};

function isoNow(): string {
  return new Date().toISOString();
}

function getPodContainers(pod: any): string[] {
  const containers = (pod.spec?.containers ?? []).map((c: any) => c.name).filter((n: any) => typeof n === "string");
  const init = (pod.spec?.initContainers ?? []).map((c: any) => c.name).filter((n: any) => typeof n === "string");
  return [...containers, ...init];
}

function podToRef(pod: any): PodRef {
  const namespace = pod.metadata?.namespace ?? "";
  const name = pod.metadata?.name ?? "";
  if (!namespace || !name) {
    throw new HttpError(500, "Unexpected pod missing namespace/name");
  }
  return {
    namespace,
    name,
    podIP: pod.status?.podIP ?? undefined,
    annotations: pod.metadata?.annotations ?? {},
    labels: pod.metadata?.labels ?? {},
    containers: getPodContainers(pod),
  };
}

async function listPodsBySelector(coreV1: CoreV1Api, namespace: string, selector: string, maxPods: number): Promise<PodRef[]> {
  const limit = maxPods + 1;
  if (namespace === "*") {
    const body = await listPodsAllNamespaces({ coreV1, labelSelector: selector, limit });
    const items = (body.items ?? []) as any[];
    const hasMore = !!body.metadata?._continue;
    if (items.length > maxPods || hasMore) {
      throw new HttpError(400, `maxPods exceeded (${maxPods})`, { maxPods });
    }
    return items.map(podToRef);
  }

  const body = await listPodsNamespaced({ coreV1, namespace, labelSelector: selector, limit });
  const items = (body.items ?? []) as any[];
  const hasMore = !!body.metadata?._continue;
  if (items.length > maxPods || hasMore) {
    throw new HttpError(400, `maxPods exceeded (${maxPods})`, { maxPods });
  }
  return items.map(podToRef);
}

async function readPodsByName(coreV1: CoreV1Api, pods: Array<{ namespace: string; pod: string }>): Promise<PodRef[]> {
  const out: PodRef[] = [];
  for (const p of pods) {
    try {
      const body = await readPod({ coreV1, namespace: p.namespace, name: p.pod });
      out.push(podToRef(body));
    } catch (err: any) {
      throw new HttpError(400, `Pod not found: ${p.namespace}/${p.pod}`);
    }
  }
  return out;
}

function parseLogLine(line: string, timestamps: boolean): { ts?: string; msg: string } {
  if (!timestamps) return { msg: line };
  const idx = line.indexOf(" ");
  if (idx <= 0) return { msg: line };
  const ts = line.slice(0, idx);
  const msg = line.slice(idx + 1);
  return { ts, msg };
}

function shouldExcludeLine(msg: string, excludePatterns: string[]): boolean {
  for (const pat of excludePatterns) {
    if (msg.includes(pat)) return true;
  }
  return false;
}

function parseLineTimeMs(ts: string | undefined): number | undefined {
  if (!ts) return undefined;
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms) || Number.isNaN(ms)) return undefined;
  return ms;
}

type LogFetchResult =
  | { ok: true; text: string }
  | { ok: false; skipped: true; reason: "no_previous_container" };

async function collectLogsForContainer(params: {
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
    // When `previous=true` but the container has not restarted, Kubernetes commonly returns 400.
    // We should still return current logs, so treat this as "no previous logs".
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

function isMetricsAnnotated(pod: PodRef): { enabled: boolean; port?: number; path: string } {
  const scrape = pod.annotations["prometheus.io/scrape"];
  if (scrape !== "true") return { enabled: false, path: "/metrics" };

  const portStr = pod.annotations["prometheus.io/port"];
  if (!portStr) return { enabled: false, path: "/metrics" };

  const port = Number.parseInt(portStr, 10);
  if (!Number.isFinite(port) || Number.isNaN(port) || port <= 0) return { enabled: false, path: "/metrics" };

  const p = pod.annotations["prometheus.io/path"]?.trim();
  const metricsPath = p && p.startsWith("/") ? p : "/metrics";
  return { enabled: true, port, path: metricsPath };
}

async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let idx = 0;

  async function worker(): Promise<void> {
    while (true) {
      const i = idx;
      idx += 1;
      if (i >= items.length) return;
      results[i] = await fn(items[i]);
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(concurrency, items.length); i++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

function eventTimestamp(ev: any): string | undefined {
  // Prefer lastTimestamp (legacy), then eventTime (newer), then creationTimestamp.
  const ts =
    (ev.lastTimestamp as unknown as string | undefined) ??
    (ev.eventTime as unknown as string | undefined) ??
    (ev.metadata?.creationTimestamp as unknown as string | undefined);
  return ts ? String(ts) : undefined;
}

export async function runBundle(params: {
  config: OAConfig;
  coreV1: CoreV1Api;
  job: BundleJob;
}): Promise<void> {
  const { config, coreV1, job } = params;
  const req: NormalizedBundleRequest = job.params;

  await fs.mkdir(config.bundleDir, { recursive: true });
  const artifactPath = path.join(config.bundleDir, `${job.bundleId}.ndjson.gz`);

  const writer = createNdjsonGzipWriter(artifactPath);
  await writer.writeRecord({
    type: "meta",
    bundleId: job.bundleId,
    createdAt: job.createdAt,
    params: req,
  });

  const pods: PodRef[] =
    req.target.kind === "pods"
      ? await readPodsByName(coreV1, req.target.pods)
      : await listPodsBySelector(coreV1, req.target.namespace, req.target.selector, req.limits.maxPods);

  const podSetByNs: Map<string, Set<string>> = new Map();
  for (const p of pods) {
    if (!podSetByNs.has(p.namespace)) podSetByNs.set(p.namespace, new Set());
    podSetByNs.get(p.namespace)!.add(p.name);
  }

  const nowMs = Date.now();
  const relSinceSeconds = req.timeWindow.kind === "relative" ? req.timeWindow.sinceSeconds : undefined;
  const absStartMs = req.timeWindow.kind === "absolute" ? Date.parse(req.timeWindow.start) : undefined;
  const absEndMs = req.timeWindow.kind === "absolute" ? Date.parse(req.timeWindow.end) : undefined;
  const eventsSinceTimeMs = req.timeWindow.kind === "relative" ? nowMs - req.timeWindow.sinceSeconds * 1000 : absStartMs!;

  if (req.include.logs.enabled) {
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
        const lines = (cur.ok ? cur.text : "").split("\n").filter((l) => l.length);
        for (const line of lines) {
          const parsed = parseLogLine(line, req.include.logs.timestamps);
          if (req.timeWindow.kind === "absolute") {
            const t = parseLineTimeMs(parsed.ts);
            if (t == null) continue;
            if (t < absStartMs! || t > absEndMs!) continue;
          }
          if (shouldExcludeLine(parsed.msg, req.include.logs.excludePatterns)) continue;
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
            const prevLines = prev.ok ? prev.text.split("\n").filter((l) => l.length) : [];
            for (const line of prevLines) {
              const parsed = parseLogLine(line, req.include.logs.timestamps);
              if (req.timeWindow.kind === "absolute") {
                const t = parseLineTimeMs(parsed.ts);
                if (t == null) continue;
                if (t < absStartMs! || t > absEndMs!) continue;
              }
              if (shouldExcludeLine(parsed.msg, req.include.logs.excludePatterns)) continue;
              await writer.writeRecord({
                type: "log",
                namespace: p.namespace,
                pod: p.name,
                container: c,
                ts: parsed.ts,
                line: parsed.msg,
              });
            }
          }
        }
      }
    }
  }

  if (req.include.events.enabled) {
    for (const [ns, podNames] of podSetByNs.entries()) {
      const body = await listEventsNamespaced({ coreV1, namespace: ns });
      for (const ev of (body.items ?? []) as any[]) {
        const ts = eventTimestamp(ev);
        if (!ts) continue;
        const timeMs = Date.parse(ts);
        if (!Number.isFinite(timeMs) || Number.isNaN(timeMs)) continue;
        if (timeMs < eventsSinceTimeMs) continue;
        if (req.timeWindow.kind === "absolute" && timeMs > absEndMs!) continue;

        const obj = ev.involvedObject;
        if (obj?.kind === "Pod" && obj.name && !podNames.has(obj.name)) continue;
        if (obj?.kind !== "Pod") continue;

        await writer.writeRecord({
          type: "event",
          namespace: ns,
          ts,
          reason: ev.reason,
          message: ev.message,
          involvedObject: {
            kind: obj?.kind,
            name: obj?.name,
            namespace: obj?.namespace,
          },
        });
      }
    }
  }

  if (req.include.metrics.enabled) {
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
        const text = await resp.text();
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

  await writer.finalize();

  job.artifactPath = artifactPath;
  const st = await fs.stat(artifactPath);
  job.artifactSizeBytes = st.size;
}
