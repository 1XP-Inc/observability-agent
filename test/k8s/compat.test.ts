import { vi } from "vitest";
import {
  listPodsAllNamespaces,
  listPodsNamespaced,
  readPod,
  readPodLog,
  listEventsNamespaced,
} from "../../src/k8s/compat";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Creates a new-style mock (fn.length <= 2) that returns { body: result }. */
function newStyleMock(result: any) {
  return vi.fn(async (_opts?: any) => ({ body: result }));
}

/** Creates a new-style mock that returns result directly (no body wrapper). */
function newStyleMockDirect(result: any) {
  return vi.fn(async (_opts?: any) => result);
}

/** Creates an old-style mock (fn.length > 2) that returns { body: result }. */
function oldStyleMock(result: any) {
  const fn = vi.fn(async () => ({ body: result }));
  Object.defineProperty(fn, "length", { value: 10 });
  return fn;
}

/** Creates an old-style mock that returns result directly (no body wrapper). */
function oldStyleMockDirect(result: any) {
  const fn = vi.fn(async () => result);
  Object.defineProperty(fn, "length", { value: 10 });
  return fn;
}

/* ------------------------------------------------------------------ */
/*  listPodsAllNamespaces                                              */
/* ------------------------------------------------------------------ */
describe("listPodsAllNamespaces", () => {
  it("throws if function is missing", async () => {
    const coreV1: any = { listPodForAllNamespaces: undefined };
    await expect(listPodsAllNamespaces({ coreV1 })).rejects.toThrow(
      "K8s client missing listPodForAllNamespaces",
    );
  });

  it("throws if property is not a function", async () => {
    const coreV1: any = { listPodForAllNamespaces: "not-a-fn" };
    await expect(listPodsAllNamespaces({ coreV1 })).rejects.toThrow(
      "K8s client missing listPodForAllNamespaces",
    );
  });

  describe("new style (fn.length <= 2)", () => {
    it("returns unwrapped body", async () => {
      const data = { items: [{ name: "pod-1" }] };
      const coreV1: any = { listPodForAllNamespaces: newStyleMock(data) };
      const result = await listPodsAllNamespaces({
        coreV1,
        labelSelector: "app=web",
        limit: 100,
      });
      expect(result).toEqual(data);
      expect(coreV1.listPodForAllNamespaces).toHaveBeenCalledWith({
        labelSelector: "app=web",
        limit: 100,
      });
    });

    it("passes continue token as _continue", async () => {
      const data = { items: [], metadata: {} };
      const coreV1: any = { listPodForAllNamespaces: newStyleMock(data) };
      await listPodsAllNamespaces({
        coreV1,
        labelSelector: "app=web",
        limit: 100,
        continueToken: "next-page",
      });
      expect(coreV1.listPodForAllNamespaces).toHaveBeenCalledWith({
        labelSelector: "app=web",
        limit: 100,
        _continue: "next-page",
      });
    });

    it("returns result directly when no body wrapper", async () => {
      const data = { items: [] };
      const coreV1: any = { listPodForAllNamespaces: newStyleMockDirect(data) };
      const result = await listPodsAllNamespaces({ coreV1 });
      expect(result).toEqual(data);
    });
  });

  describe("old style (fn.length > 2)", () => {
    it("returns unwrapped body with correct positional args", async () => {
      const data = { items: [{ name: "pod-2" }] };
      const fn = oldStyleMock(data);
      const coreV1: any = { listPodForAllNamespaces: fn };
      const result = await listPodsAllNamespaces({
        coreV1,
        labelSelector: "app=api",
        limit: 50,
      });
      expect(result).toEqual(data);
      expect(fn).toHaveBeenCalledWith(
        undefined,
        undefined,
        undefined,
        undefined,
        "app=api",
        50,
      );
    });

    it("returns result directly when no body wrapper", async () => {
      const data = { items: [] };
      const coreV1: any = { listPodForAllNamespaces: oldStyleMockDirect(data) };
      const result = await listPodsAllNamespaces({ coreV1 });
      expect(result).toEqual(data);
    });
  });
});

/* ------------------------------------------------------------------ */
/*  listPodsNamespaced                                                 */
/* ------------------------------------------------------------------ */
describe("listPodsNamespaced", () => {
  it("throws if function is missing", async () => {
    const coreV1: any = { listNamespacedPod: undefined };
    await expect(
      listPodsNamespaced({ coreV1, namespace: "default" }),
    ).rejects.toThrow("K8s client missing listNamespacedPod");
  });

  describe("new style (fn.length <= 2)", () => {
    it("returns unwrapped body", async () => {
      const data = { items: [{ name: "pod-a" }] };
      const coreV1: any = { listNamespacedPod: newStyleMock(data) };
      const result = await listPodsNamespaced({
        coreV1,
        namespace: "prod",
        labelSelector: "app=web",
        limit: 10,
      });
      expect(result).toEqual(data);
      expect(coreV1.listNamespacedPod).toHaveBeenCalledWith({
        namespace: "prod",
        labelSelector: "app=web",
        limit: 10,
      });
    });

    it("returns result directly when no body wrapper", async () => {
      const data = { items: [] };
      const coreV1: any = { listNamespacedPod: newStyleMockDirect(data) };
      const result = await listPodsNamespaced({ coreV1, namespace: "ns" });
      expect(result).toEqual(data);
    });
  });

  describe("old style (fn.length > 2)", () => {
    it("returns unwrapped body with correct positional args", async () => {
      const data = { items: [{ name: "pod-b" }] };
      const fn = oldStyleMock(data);
      const coreV1: any = { listNamespacedPod: fn };
      const result = await listPodsNamespaced({
        coreV1,
        namespace: "staging",
        labelSelector: "app=api",
        limit: 25,
      });
      expect(result).toEqual(data);
      expect(fn).toHaveBeenCalledWith(
        "staging",
        undefined,
        undefined,
        undefined,
        undefined,
        "app=api",
        25,
      );
    });

    it("passes continue token in the positional _continue slot", async () => {
      const fn = oldStyleMock({ items: [] });
      const coreV1: any = { listNamespacedPod: fn };
      await listPodsNamespaced({
        coreV1,
        namespace: "staging",
        labelSelector: "app=api",
        limit: 25,
        continueToken: "next-page",
      });
      expect(fn).toHaveBeenCalledWith(
        "staging",
        undefined,
        undefined,
        "next-page",
        undefined,
        "app=api",
        25,
      );
    });

    it("returns result directly when no body wrapper", async () => {
      const data = { items: [] };
      const coreV1: any = { listNamespacedPod: oldStyleMockDirect(data) };
      const result = await listPodsNamespaced({ coreV1, namespace: "ns" });
      expect(result).toEqual(data);
    });
  });
});

/* ------------------------------------------------------------------ */
/*  readPod                                                            */
/* ------------------------------------------------------------------ */
describe("readPod", () => {
  it("throws if function is missing", async () => {
    const coreV1: any = { readNamespacedPod: undefined };
    await expect(
      readPod({ coreV1, namespace: "default", name: "pod-1" }),
    ).rejects.toThrow("K8s client missing readNamespacedPod");
  });

  describe("new style (fn.length <= 2)", () => {
    it("returns unwrapped body", async () => {
      const data = { metadata: { name: "pod-1" } };
      const coreV1: any = { readNamespacedPod: newStyleMock(data) };
      const result = await readPod({ coreV1, namespace: "ns", name: "pod-1" });
      expect(result).toEqual(data);
      expect(coreV1.readNamespacedPod).toHaveBeenCalledWith({
        namespace: "ns",
        name: "pod-1",
      });
    });

    it("returns result directly when no body wrapper", async () => {
      const data = { metadata: { name: "pod-1" } };
      const coreV1: any = { readNamespacedPod: newStyleMockDirect(data) };
      const result = await readPod({ coreV1, namespace: "ns", name: "pod-1" });
      expect(result).toEqual(data);
    });
  });

  describe("old style (fn.length > 2)", () => {
    it("returns unwrapped body with correct positional args", async () => {
      const data = { metadata: { name: "pod-1" } };
      const fn = oldStyleMock(data);
      const coreV1: any = { readNamespacedPod: fn };
      const result = await readPod({ coreV1, namespace: "ns", name: "pod-1" });
      expect(result).toEqual(data);
      expect(fn).toHaveBeenCalledWith("pod-1", "ns");
    });

    it("returns result directly when no body wrapper", async () => {
      const data = { metadata: { name: "pod-1" } };
      const coreV1: any = { readNamespacedPod: oldStyleMockDirect(data) };
      const result = await readPod({ coreV1, namespace: "ns", name: "pod-1" });
      expect(result).toEqual(data);
    });
  });
});

/* ------------------------------------------------------------------ */
/*  readPodLog                                                         */
/* ------------------------------------------------------------------ */
describe("readPodLog", () => {
  const baseParams = {
    namespace: "ns",
    name: "pod-1",
    container: "main",
    tailLines: 100,
    timestamps: true,
    previous: false,
    sinceSeconds: 300,
  };

  it("throws if function is missing", async () => {
    const coreV1: any = { readNamespacedPodLog: undefined };
    await expect(readPodLog({ coreV1, ...baseParams })).rejects.toThrow(
      "K8s client missing readNamespacedPodLog",
    );
  });

  describe("new style (fn.length <= 2)", () => {
    it("returns unwrapped string body", async () => {
      const coreV1: any = {
        readNamespacedPodLog: newStyleMock("log line 1\nlog line 2"),
      };
      const result = await readPodLog({ coreV1, ...baseParams });
      expect(result).toBe("log line 1\nlog line 2");
      expect(coreV1.readNamespacedPodLog).toHaveBeenCalledWith({
        namespace: "ns",
        name: "pod-1",
        container: "main",
        follow: false,
        previous: false,
        sinceSeconds: 300,
        sinceTime: undefined,
        tailLines: 100,
        timestamps: true,
      });
    });

    it("passes sinceTime when provided", async () => {
      const coreV1: any = {
        readNamespacedPodLog: newStyleMock("log"),
      };
      await readPodLog({
        coreV1,
        ...baseParams,
        sinceTime: "2024-01-01T00:00:00Z",
      });
      expect(coreV1.readNamespacedPodLog).toHaveBeenCalledWith(
        expect.objectContaining({ sinceTime: "2024-01-01T00:00:00Z" }),
      );
    });

    it("returns result directly when no body wrapper (string)", async () => {
      const coreV1: any = {
        readNamespacedPodLog: newStyleMockDirect("direct log"),
      };
      const result = await readPodLog({ coreV1, ...baseParams });
      expect(result).toBe("direct log");
    });

    it("coerces non-string body to String", async () => {
      const coreV1: any = {
        readNamespacedPodLog: newStyleMock(12345),
      };
      const result = await readPodLog({ coreV1, ...baseParams });
      expect(result).toBe("12345");
    });

    it("coerces non-string direct result to String", async () => {
      // Returns a number directly (no body wrapper)
      const coreV1: any = {
        readNamespacedPodLog: newStyleMockDirect(99),
      };
      const result = await readPodLog({ coreV1, ...baseParams });
      expect(result).toBe("99");
    });

    it("coerces null body to String", async () => {
      const coreV1: any = {
        readNamespacedPodLog: newStyleMock(null),
      };
      const result = await readPodLog({ coreV1, ...baseParams });
      expect(result).toBe("null");
    });
  });

  describe("old style (fn.length > 2)", () => {
    it("shape 1 works: returns unwrapped string body", async () => {
      const fn = oldStyleMock("old-log-output");
      const coreV1: any = { readNamespacedPodLog: fn };
      const result = await readPodLog({ coreV1, ...baseParams });
      expect(result).toBe("old-log-output");
    });

    it("shape 1: correct positional args", async () => {
      const fn = oldStyleMock("log");
      const coreV1: any = { readNamespacedPodLog: fn };
      await readPodLog({ coreV1, ...baseParams });
      // Shape 1: (name, namespace, container, follow, pretty, _continue, limitBytes, previous, sinceSeconds, tailLines, timestamps)
      expect(fn).toHaveBeenCalledWith(
        "pod-1",    // name
        "ns",       // namespace
        "main",     // container
        false,      // follow
        undefined,  // pretty
        undefined,  // _continue
        undefined,  // limitBytes
        false,      // previous
        300,        // sinceSeconds
        100,        // tailLines
        true,       // timestamps
      );
    });

    it("shape 2 works when shape 1 fails", async () => {
      let callCount = 0;
      const fn = vi.fn(async (...args: any[]) => {
        callCount++;
        if (callCount === 1) throw new Error("shape 1 failed");
        return { body: "shape-2-log" };
      });
      Object.defineProperty(fn, "length", { value: 10 });
      const coreV1: any = { readNamespacedPodLog: fn };
      const result = await readPodLog({ coreV1, ...baseParams });
      expect(result).toBe("shape-2-log");
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("both shapes fail: throws last error", async () => {
      const fn = vi.fn(async () => {
        throw new Error("all shapes fail");
      });
      Object.defineProperty(fn, "length", { value: 10 });
      const coreV1: any = { readNamespacedPodLog: fn };
      await expect(readPodLog({ coreV1, ...baseParams })).rejects.toThrow(
        "all shapes fail",
      );
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("coerces non-string body to String in old style", async () => {
      const fn = oldStyleMock(42);
      const coreV1: any = { readNamespacedPodLog: fn };
      const result = await readPodLog({ coreV1, ...baseParams });
      expect(result).toBe("42");
    });

    it("returns direct result without body wrapper in old style", async () => {
      const fn = oldStyleMockDirect("direct-old-log");
      const coreV1: any = { readNamespacedPodLog: fn };
      const result = await readPodLog({ coreV1, ...baseParams });
      expect(result).toBe("direct-old-log");
    });

    it("uses shape 2 first when sinceTime is provided", async () => {
      const fn = vi.fn(async () => ({ body: "absolute-log" }));
      Object.defineProperty(fn, "length", { value: 10 });
      const coreV1: any = { readNamespacedPodLog: fn };
      await readPodLog({
        coreV1,
        ...baseParams,
        sinceSeconds: undefined,
        sinceTime: "2024-01-01T00:00:00Z",
      });
      // Shape 2: (name, namespace, container, follow, pretty, previous, sinceSeconds, sinceTime, timestamps, tailLines, limitBytes)
      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith(
        "pod-1",                      // name
        "ns",                         // namespace
        "main",                       // container
        false,                        // follow
        undefined,                    // pretty
        false,                        // previous
        undefined,                    // sinceSeconds
        "2024-01-01T00:00:00Z",       // sinceTime
        true,                         // timestamps
        100,                          // tailLines
        undefined,                    // limitBytes
      );
    });
  });
});

/* ------------------------------------------------------------------ */
/*  listEventsNamespaced                                               */
/* ------------------------------------------------------------------ */
describe("listEventsNamespaced", () => {
  it("throws if function is missing", async () => {
    const coreV1: any = { listNamespacedEvent: undefined };
    await expect(
      listEventsNamespaced({ coreV1, namespace: "default" }),
    ).rejects.toThrow("K8s client missing listNamespacedEvent");
  });

  describe("new style (fn.length <= 2)", () => {
    it("returns unwrapped body", async () => {
      const data = { items: [{ reason: "Started" }] };
      const coreV1: any = { listNamespacedEvent: newStyleMock(data) };
      const result = await listEventsNamespaced({ coreV1, namespace: "ns" });
      expect(result).toEqual(data);
      expect(coreV1.listNamespacedEvent).toHaveBeenCalledWith({
        namespace: "ns",
      });
    });

    it("returns result directly when no body wrapper", async () => {
      const data = { items: [] };
      const coreV1: any = { listNamespacedEvent: newStyleMockDirect(data) };
      const result = await listEventsNamespaced({ coreV1, namespace: "ns" });
      expect(result).toEqual(data);
    });
  });

  describe("old style (fn.length > 2)", () => {
    it("returns unwrapped body with correct positional arg", async () => {
      const data = { items: [{ reason: "Killed" }] };
      const fn = oldStyleMock(data);
      const coreV1: any = { listNamespacedEvent: fn };
      const result = await listEventsNamespaced({
        coreV1,
        namespace: "staging",
      });
      expect(result).toEqual(data);
      expect(fn).toHaveBeenCalledWith("staging");
    });

    it("returns result directly when no body wrapper", async () => {
      const data = { items: [] };
      const coreV1: any = { listNamespacedEvent: oldStyleMockDirect(data) };
      const result = await listEventsNamespaced({ coreV1, namespace: "ns" });
      expect(result).toEqual(data);
    });
  });
});
