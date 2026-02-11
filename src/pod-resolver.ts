import type { CoreV1Api } from "@kubernetes/client-node";
import { HttpError } from "./http-error";
import type { PodRef } from "./types";
import { listPodsAllNamespaces, listPodsNamespaced, readPod } from "./k8s-compat";

export function getPodContainers(pod: any): string[] {
  const containers = (pod.spec?.containers ?? []).map((c: any) => c.name).filter((n: any) => typeof n === "string");
  const init = (pod.spec?.initContainers ?? []).map((c: any) => c.name).filter((n: any) => typeof n === "string");
  return [...containers, ...init];
}

export function podToRef(pod: any): PodRef {
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

export async function listPodsBySelector(coreV1: CoreV1Api, namespace: string, selector: string, maxPods: number): Promise<PodRef[]> {
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

export async function readPodsByName(coreV1: CoreV1Api, pods: Array<{ namespace: string; pod: string }>): Promise<PodRef[]> {
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
