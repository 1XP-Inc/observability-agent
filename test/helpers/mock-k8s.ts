import { vi } from "vitest";
import type { CoreV1Api } from "@kubernetes/client-node";

/**
 * Creates a mock CoreV1Api with all methods needed by the codebase.
 * Each method is a vi.fn() that can be configured per test.
 * Default: "new style" API (fn.length <= 2) returning { body: result }.
 */
export function createMockCoreV1Api(overrides?: Partial<Record<string, any>>): CoreV1Api {
  const defaultPodList = { items: [], metadata: {} };
  const defaultEventList = { items: [], metadata: {} };

  // Create functions that mimic "new style" (fn.length <= 2)
  const newStyleFn = (result: any) => {
    const fn = vi.fn(async (_opts?: any) => ({ body: result }));
    return fn;
  };

  const mock: any = {
    listPodForAllNamespaces: newStyleFn(defaultPodList),
    listNamespacedPod: newStyleFn(defaultPodList),
    readNamespacedPod: newStyleFn({}),
    readNamespacedPodLog: newStyleFn(""),
    listNamespacedEvent: newStyleFn(defaultEventList),
    ...overrides,
  };

  return mock as CoreV1Api;
}

/**
 * Creates a mock pod object as returned by K8s API.
 */
export function createMockPod(opts: {
  namespace?: string;
  name?: string;
  podIP?: string;
  containers?: string[];
  initContainers?: string[];
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  nodeName?: string;
  phase?: string;
  ready?: boolean;
}): any {
  const ns = opts.namespace ?? "default";
  const name = opts.name ?? "test-pod";
  return {
    metadata: {
      namespace: ns,
      name,
      labels: opts.labels ?? {},
      annotations: opts.annotations ?? {},
    },
    spec: {
      containers: (opts.containers ?? ["main"]).map((c) => ({ name: c })),
      initContainers: (opts.initContainers ?? []).map((c) => ({ name: c })),
      nodeName: opts.nodeName ?? "node-1",
    },
    status: {
      podIP: opts.podIP ?? "10.0.0.1",
      phase: opts.phase ?? "Running",
      conditions: opts.ready !== false
        ? [{ type: "Ready", status: "True" }]
        : [{ type: "Ready", status: "False" }],
    },
  };
}

/**
 * Creates a mock K8s event object.
 */
export function createMockEvent(opts: {
  namespace?: string;
  reason?: string;
  message?: string;
  lastTimestamp?: string;
  eventTime?: string;
  involvedObject?: { kind: string; name: string; namespace: string };
}): any {
  return {
    metadata: { creationTimestamp: new Date().toISOString() },
    lastTimestamp: opts.lastTimestamp ?? new Date().toISOString(),
    eventTime: opts.eventTime,
    reason: opts.reason ?? "Started",
    message: opts.message ?? "Started container",
    involvedObject: opts.involvedObject ?? {
      kind: "Pod",
      name: "test-pod",
      namespace: opts.namespace ?? "default",
    },
  };
}
