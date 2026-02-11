import type { CoreV1Api } from "@kubernetes/client-node";
import type { NdjsonGzipWriter } from "./bundle-writer";
import type { NormalizedBundleRequest } from "./types";
import { listEventsNamespaced } from "./k8s-compat";

export function eventTimestamp(ev: any): string | undefined {
  const ts =
    (ev.lastTimestamp as unknown as string | undefined) ??
    (ev.eventTime as unknown as string | undefined) ??
    (ev.metadata?.creationTimestamp as unknown as string | undefined);
  return ts ? String(ts) : undefined;
}

export async function collectEvents(params: {
  coreV1: CoreV1Api;
  writer: NdjsonGzipWriter;
  podSetByNs: Map<string, Set<string>>;
  req: NormalizedBundleRequest;
  eventsSinceTimeMs: number;
}): Promise<void> {
  const { coreV1, writer, podSetByNs, req } = params;
  const absEndMs = req.timeWindow.kind === "absolute" ? Date.parse(req.timeWindow.end) : undefined;

  for (const [ns, podNames] of podSetByNs.entries()) {
    const body = await listEventsNamespaced({ coreV1, namespace: ns });
    for (const ev of (body.items ?? []) as any[]) {
      const ts = eventTimestamp(ev);
      if (!ts) continue;
      const timeMs = Date.parse(ts);
      if (!Number.isFinite(timeMs) || Number.isNaN(timeMs)) continue;
      if (timeMs < params.eventsSinceTimeMs) continue;
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
