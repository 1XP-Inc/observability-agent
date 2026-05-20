import type { CoreV1Api } from "@kubernetes/client-node";
import type { NdjsonGzipWriter } from "../bundle-writer";
import type { NormalizedBundleRequest } from "./types";
import { listEventsNamespaced } from "./compat";

export function eventTimestamp(ev: any): string | undefined {
  const ts =
    (ev.lastTimestamp as unknown as string | undefined) ??
    (ev.eventTime as unknown as string | undefined) ??
    (ev.metadata?.creationTimestamp as unknown as string | undefined);
  return ts ? String(ts) : undefined;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function eventMatchesSelectedPod(obj: any, podUidByName: Map<string, string | undefined>): boolean {
  if (obj?.kind !== "Pod") return false;

  const name = nonEmptyString(obj.name);
  if (!name || !podUidByName.has(name)) return false;

  const selectedUid = podUidByName.get(name);
  const eventUid = nonEmptyString(obj.uid);
  if (selectedUid && eventUid) return selectedUid === eventUid;

  return true;
}

export async function collectEvents(params: {
  coreV1: CoreV1Api;
  writer: NdjsonGzipWriter;
  podUidByNameByNs: Map<string, Map<string, string | undefined>>;
  req: NormalizedBundleRequest;
  eventsSinceTimeMs: number;
}): Promise<void> {
  const { coreV1, writer, podUidByNameByNs, req } = params;
  const absEndMs = req.timeWindow.kind === "absolute" ? Date.parse(req.timeWindow.end) : undefined;

  for (const [ns, podUidByName] of podUidByNameByNs.entries()) {
    const body = await listEventsNamespaced({ coreV1, namespace: ns });
    for (const ev of (body.items ?? []) as any[]) {
      const ts = eventTimestamp(ev);
      if (!ts) continue;
      const timeMs = Date.parse(ts);
      if (!Number.isFinite(timeMs) || Number.isNaN(timeMs)) continue;
      if (timeMs < params.eventsSinceTimeMs) continue;
      if (req.timeWindow.kind === "absolute" && timeMs > absEndMs!) continue;

      const obj = ev.involvedObject;
      if (!eventMatchesSelectedPod(obj, podUidByName)) continue;

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
