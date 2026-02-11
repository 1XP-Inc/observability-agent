import type { CoreV1Api } from "@kubernetes/client-node";

function unwrapBody<T>(res: unknown): T {
  // client-node versions differ:
  // - some return `{ body: T, response: ... }`
  // - some return `T` directly
  const anyRes = res as any;
  if (anyRes && typeof anyRes === "object" && "body" in anyRes) return anyRes.body as T;
  return anyRes as T;
}

export async function listPodsAllNamespaces(params: {
  coreV1: CoreV1Api;
  labelSelector?: string;
  limit?: number;
}): Promise<any> {
  const fn = (params.coreV1 as any).listPodForAllNamespaces as Function;
  if (typeof fn !== "function") throw new Error("K8s client missing listPodForAllNamespaces");

  if (fn.length <= 2) {
    // Newer: (request?: { ... }, options?)
    const res = await (params.coreV1 as any).listPodForAllNamespaces({
      labelSelector: params.labelSelector,
      limit: params.limit,
    });
    return unwrapBody<any>(res);
  }

  // Older: (pretty?, allowWatchBookmarks?, _continue?, fieldSelector?, labelSelector?, limit?, ...)
  const res = await (params.coreV1 as any).listPodForAllNamespaces(
    undefined,
    undefined,
    undefined,
    undefined,
    params.labelSelector,
    params.limit,
  );
  return unwrapBody<any>(res);
}

export async function listPodsNamespaced(params: {
  coreV1: CoreV1Api;
  namespace: string;
  labelSelector?: string;
  limit?: number;
}): Promise<any> {
  const fn = (params.coreV1 as any).listNamespacedPod as Function;
  if (typeof fn !== "function") throw new Error("K8s client missing listNamespacedPod");

  if (fn.length <= 2) {
    const res = await (params.coreV1 as any).listNamespacedPod({
      namespace: params.namespace,
      labelSelector: params.labelSelector,
      limit: params.limit,
    });
    return unwrapBody<any>(res);
  }

  const res = await (params.coreV1 as any).listNamespacedPod(
    params.namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    params.labelSelector,
    params.limit,
  );
  return unwrapBody<any>(res);
}

export async function readPod(params: {
  coreV1: CoreV1Api;
  namespace: string;
  name: string;
}): Promise<any> {
  const fn = (params.coreV1 as any).readNamespacedPod as Function;
  if (typeof fn !== "function") throw new Error("K8s client missing readNamespacedPod");

  if (fn.length <= 2) {
    const res = await (params.coreV1 as any).readNamespacedPod({
      namespace: params.namespace,
      name: params.name,
    });
    return unwrapBody<any>(res);
  }

  const res = await (params.coreV1 as any).readNamespacedPod(params.name, params.namespace);
  return unwrapBody<any>(res);
}

export async function readPodLog(params: {
  coreV1: CoreV1Api;
  namespace: string;
  name: string;
  container: string;
  sinceSeconds?: number;
  sinceTime?: string; // RFC3339/ISO8601
  tailLines: number;
  timestamps: boolean;
  previous: boolean;
}): Promise<string> {
  const fn = (params.coreV1 as any).readNamespacedPodLog as Function;
  if (typeof fn !== "function") throw new Error("K8s client missing readNamespacedPodLog");

  if (fn.length <= 2) {
    const res = await (params.coreV1 as any).readNamespacedPodLog({
      namespace: params.namespace,
      name: params.name,
      container: params.container,
      follow: false,
      previous: params.previous,
      sinceSeconds: params.sinceSeconds,
      sinceTime: params.sinceTime,
      tailLines: params.tailLines,
      timestamps: params.timestamps,
    });
    const body = unwrapBody<any>(res);
    return typeof body === "string" ? body : String(body);
  }

  // Best-effort positional call for older clients. Signatures vary a lot across versions,
  // so try a couple of common shapes.
  const tryCalls: Array<() => Promise<unknown>> = [
    // Shape similar to older client-node we started with:
    // (name, namespace, container, follow, pretty, _continue, limitBytes, previous, sinceSeconds, tailLines, timestamps)
    async () =>
      (params.coreV1 as any).readNamespacedPodLog(
        params.name,
        params.namespace,
        params.container,
        false,
        undefined,
        undefined,
        undefined,
        params.previous,
        params.sinceSeconds,
        params.tailLines,
        params.timestamps,
      ),
    // Another common shape:
    // (name, namespace, container, follow, pretty, previous, sinceSeconds, sinceTime, timestamps, tailLines, limitBytes)
    async () =>
      (params.coreV1 as any).readNamespacedPodLog(
        params.name,
        params.namespace,
        params.container,
        false,
        undefined,
        params.previous,
        params.sinceSeconds,
        params.sinceTime,
        params.timestamps,
        params.tailLines,
        undefined,
      ),
  ];

  let lastErr: unknown;
  for (const fnCall of tryCalls) {
    try {
      const res = await fnCall();
      const body = unwrapBody<any>(res);
      return typeof body === "string" ? body : String(body);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export async function listEventsNamespaced(params: {
  coreV1: CoreV1Api;
  namespace: string;
}): Promise<any> {
  const fn = (params.coreV1 as any).listNamespacedEvent as Function;
  if (typeof fn !== "function") throw new Error("K8s client missing listNamespacedEvent");

  if (fn.length <= 2) {
    const res = await (params.coreV1 as any).listNamespacedEvent({ namespace: params.namespace });
    return unwrapBody<any>(res);
  }

  const res = await (params.coreV1 as any).listNamespacedEvent(params.namespace);
  return unwrapBody<any>(res);
}
