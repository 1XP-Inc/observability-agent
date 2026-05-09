import { vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authHook } from "../../src/auth";
import { HttpError } from "../../src/http-error";
import { registerRoutes } from "../../src/k8s/routes";
import type { BundleJob, BundleArtifact } from "../../src/types";
import type { NormalizedBundleRequest } from "../../src/k8s/types";
import { createMockConfig, createMockCoreV1Api, createMockPod } from "../helpers";

// ---------------------------------------------------------------------------
// hasString — replicated for local tests of the helper itself
// ---------------------------------------------------------------------------
function hasString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SECRET = "test-secret-key-for-testing-hs256";

function validToken(payload?: Record<string, any>) {
  return jwt.sign(
    { sub: "test-user", exp: Math.floor(Date.now() / 1000) + 300, ...payload },
    SECRET,
    { algorithm: "HS256" },
  );
}

function authHeader(payload: Record<string, any> = { admin: true }) {
  return { authorization: `Bearer ${validToken(payload)}` };
}

// Mock bundle manager
function createMockBundleManager() {
  const jobs = new Map<string, BundleJob>();
  const artifacts = new Map<string, BundleArtifact>();

  return {
    jobs,
    artifacts,
    create: vi.fn(async (params: NormalizedBundleRequest): Promise<BundleJob> => {
      const job: BundleJob = {
        bundleId: "bnd_test123",
        status: "queued",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        params,
      };
      jobs.set(job.bundleId, job);
      return job;
    }),
    get: vi.fn((bundleId: string) => jobs.get(bundleId)),
    getArtifact: vi.fn((bundleId: string) => artifacts.get(bundleId)),
    startCleanupLoop: vi.fn(),
  };
}

// Build a Fastify app using registerRoutes (mirrors index.ts bootstrap)
function buildApp(opts?: {
  coreV1Override?: any;
  bundleManagerOverride?: ReturnType<typeof createMockBundleManager>;
}) {
  const config = createMockConfig({ jwtSecret: SECRET });
  const coreV1 = opts?.coreV1Override ?? createMockCoreV1Api();
  const bundles = opts?.bundleManagerOverride ?? createMockBundleManager();

  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });

  // /healthz is registered BEFORE auth hook (same as index.ts)
  app.get("/healthz", async () => ({ ok: true }));

  app.addHook("onRequest", authHook(config));
  registerRoutes(app, { config, coreV1, bundles });

  return { app, config, coreV1, bundles };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("hasString (inline helper)", () => {
  it("returns false for empty string", () => {
    expect(hasString("")).toBe(false);
  });

  it("returns false for non-string types", () => {
    expect(hasString(undefined)).toBe(false);
    expect(hasString(null)).toBe(false);
    expect(hasString(0)).toBe(false);
    expect(hasString(123)).toBe(false);
    expect(hasString(false)).toBe(false);
    expect(hasString({})).toBe(false);
    expect(hasString([])).toBe(false);
  });

  it("returns true for non-empty string", () => {
    expect(hasString("hello")).toBe(true);
    expect(hasString(" ")).toBe(true);
    expect(hasString("0")).toBe(true);
  });
});

describe("GET /healthz", () => {
  it("returns { ok: true } with 200", async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it("does not require auth", async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("GET /skill.md", () => {
  it("returns markdown content with correct Content-Type", async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: "GET", url: "/skill.md" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.body).toContain("OA");
    await app.close();
  });

  it("does not require auth", async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: "GET", url: "/skill.md" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("GET /.well-known/skill.md", () => {
  it("returns markdown content with correct Content-Type", async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: "GET", url: "/.well-known/skill.md" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    expect(res.body).toContain("OA");
    await app.close();
  });

  it("does not require auth", async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: "GET", url: "/.well-known/skill.md" });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});

describe("GET /v1/pods", () => {
  it("requires auth — 401 without token", async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/pods" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("rejects ns=* for scoped non-admin tokens", async () => {
    const coreV1 = createMockCoreV1Api();
    const { app } = buildApp({ coreV1Override: coreV1 });
    const res = await app.inject({
      method: "GET",
      url: "/v1/pods?ns=*",
      headers: authHeader({ allowedNamespaces: ["prod"], capabilities: ["pods"] }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
    expect((coreV1 as any).listPodForAllNamespaces).not.toHaveBeenCalled();
    await app.close();
  });

  it("allows ns=* when scoped token explicitly allows all namespaces", async () => {
    const coreV1 = createMockCoreV1Api();
    const pod = createMockPod({ namespace: "prod", name: "pod-1" });
    (coreV1 as any).listPodForAllNamespaces.mockResolvedValue({ body: { items: [pod] } });
    const { app } = buildApp({ coreV1Override: coreV1 });
    const res = await app.inject({
      method: "GET",
      url: "/v1/pods?ns=*",
      headers: authHeader({ allowedNamespaces: ["*"], capabilities: ["pods"] }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect((coreV1 as any).listPodForAllNamespaces).toHaveBeenCalled();
    await app.close();
  });

  it("allows namespace wildcard patterns for scoped tokens", async () => {
    const coreV1 = createMockCoreV1Api();
    const pod = createMockPod({ namespace: "prod-a", name: "pod-1" });
    (coreV1 as any).listNamespacedPod.mockResolvedValue({ body: { items: [pod] } });
    const { app } = buildApp({ coreV1Override: coreV1 });
    const res = await app.inject({
      method: "GET",
      url: "/v1/pods?ns=prod-a",
      headers: authHeader({ allowedNamespaces: ["prod-*"], capabilities: ["pods"] }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toHaveLength(1);
    expect((coreV1 as any).listNamespacedPod).toHaveBeenCalled();
    await app.close();
  });

  it("rejects pods listing without pods capability", async () => {
    const coreV1 = createMockCoreV1Api();
    const { app } = buildApp({ coreV1Override: coreV1 });
    const res = await app.inject({
      method: "GET",
      url: "/v1/pods?ns=prod",
      headers: authHeader({ allowedNamespaces: ["prod"], capabilities: ["logs"] }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
    expect((coreV1 as any).listNamespacedPod).not.toHaveBeenCalled();
    await app.close();
  });

  it("defaults to ns=* (listPodsAllNamespaces) when no query params", async () => {
    const coreV1 = createMockCoreV1Api();
    const pod1 = createMockPod({ namespace: "ns-a", name: "pod-1" });
    (coreV1 as any).listPodForAllNamespaces.mockResolvedValue({ body: { items: [pod1] } });

    const { app } = buildApp({ coreV1Override: coreV1 });
    const res = await app.inject({
      method: "GET",
      url: "/v1/pods",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].namespace).toBe("ns-a");
    expect(body.items[0].name).toBe("pod-1");
    expect((coreV1 as any).listPodForAllNamespaces).toHaveBeenCalled();
    await app.close();
  });

  it("preserves full access for legacy tokens without authorization claims", async () => {
    const coreV1 = createMockCoreV1Api();
    const pod = createMockPod({ namespace: "ns-a", name: "pod-1" });
    (coreV1 as any).listPodForAllNamespaces.mockResolvedValue({ body: { items: [pod] } });

    const { app } = buildApp({ coreV1Override: coreV1 });
    const res = await app.inject({
      method: "GET",
      url: "/v1/pods",
      headers: { authorization: `Bearer ${validToken({})}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toMatchObject({
      namespace: "ns-a",
      name: "pod-1",
      podIP: pod.status?.podIP,
      annotations: pod.metadata?.annotations,
      nodeName: pod.spec?.nodeName,
    });
    await app.close();
  });

  it("calls listPodsNamespaced when ns is specified", async () => {
    const coreV1 = createMockCoreV1Api();
    const pod1 = createMockPod({ namespace: "kube-system", name: "coredns" });
    (coreV1 as any).listNamespacedPod.mockResolvedValue({ body: { items: [pod1] } });

    const { app } = buildApp({ coreV1Override: coreV1 });
    const res = await app.inject({
      method: "GET",
      url: "/v1/pods?ns=kube-system",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0].name).toBe("coredns");
    expect((coreV1 as any).listNamespacedPod).toHaveBeenCalled();
    await app.close();
  });

  it("passes selector through to k8s API", async () => {
    const coreV1 = createMockCoreV1Api();
    (coreV1 as any).listPodForAllNamespaces.mockResolvedValue({ body: { items: [] } });

    const { app } = buildApp({ coreV1Override: coreV1 });
    await app.inject({
      method: "GET",
      url: "/v1/pods?selector=app%3Dnginx",
      headers: authHeader(),
    });
    const callArgs = (coreV1 as any).listPodForAllNamespaces.mock.calls[0][0];
    expect(callArgs.labelSelector).toBe("app=nginx");
    await app.close();
  });

  it("filters pods by q (name substring)", async () => {
    const coreV1 = createMockCoreV1Api();
    const pods = [
      createMockPod({ name: "frontend-abc" }),
      createMockPod({ name: "backend-xyz" }),
      createMockPod({ name: "frontend-def" }),
    ];
    (coreV1 as any).listPodForAllNamespaces.mockResolvedValue({ body: { items: pods } });

    const { app } = buildApp({ coreV1Override: coreV1 });
    const res = await app.inject({
      method: "GET",
      url: "/v1/pods?q=frontend",
      headers: authHeader(),
    });
    const body = res.json();
    expect(body.items).toHaveLength(2);
    expect(body.items.every((p: any) => p.name.includes("frontend"))).toBe(true);
    await app.close();
  });

  it("returns all pods when q is not provided (no filter)", async () => {
    const coreV1 = createMockCoreV1Api();
    const pods = [
      createMockPod({ name: "a" }),
      createMockPod({ name: "b" }),
    ];
    (coreV1 as any).listPodForAllNamespaces.mockResolvedValue({ body: { items: pods } });

    const { app } = buildApp({ coreV1Override: coreV1 });
    const res = await app.inject({
      method: "GET",
      url: "/v1/pods",
      headers: authHeader(),
    });
    expect(res.json().items).toHaveLength(2);
    await app.close();
  });

  it("maps pod fields correctly in response", async () => {
    const coreV1 = createMockCoreV1Api();
    const pod = createMockPod({
      namespace: "prod",
      name: "web-server",
      podIP: "10.1.2.3",
      labels: { app: "web" },
      annotations: { version: "v2" },
      containers: ["nginx", "sidecar"],
      nodeName: "node-5",
      phase: "Running",
      ready: true,
    });
    (coreV1 as any).listPodForAllNamespaces.mockResolvedValue({ body: { items: [pod] } });

    const { app } = buildApp({ coreV1Override: coreV1 });
    const res = await app.inject({
      method: "GET",
      url: "/v1/pods",
      headers: authHeader(),
    });
    const item = res.json().items[0];
    expect(item.namespace).toBe("prod");
    expect(item.name).toBe("web-server");
    expect(item.podIP).toBe("10.1.2.3");
    expect(item.labels).toEqual({ app: "web" });
    expect(item.annotations).toEqual({ version: "v2" });
    expect(item.containers).toEqual(["nginx", "sidecar"]);
    expect(item.ready).toBe(true);
    expect(item.nodeName).toBe("node-5");
    expect(item.phase).toBe("Running");
    await app.close();
  });

  it("redacts admin-only pod fields for scoped tokens", async () => {
    const coreV1 = createMockCoreV1Api();
    const pod = createMockPod({
      namespace: "prod",
      name: "web-server",
      podIP: "10.1.2.3",
      labels: { app: "web" },
      annotations: { secret: "value" },
      nodeName: "node-5",
    });
    (coreV1 as any).listNamespacedPod.mockResolvedValue({ body: { items: [pod] } });

    const { app } = buildApp({ coreV1Override: coreV1 });
    const res = await app.inject({
      method: "GET",
      url: "/v1/pods?ns=prod",
      headers: authHeader({ allowedNamespaces: ["prod"], capabilities: ["pods"] }),
    });
    expect(res.statusCode).toBe(200);
    const item = res.json().items[0];
    expect(item.namespace).toBe("prod");
    expect(item.name).toBe("web-server");
    expect(item.labels).toEqual({ app: "web" });
    expect(item).not.toHaveProperty("podIP");
    expect(item).not.toHaveProperty("annotations");
    expect(item).not.toHaveProperty("nodeName");
    await app.close();
  });

  it("ready=false when pod has no Ready=True condition", async () => {
    const coreV1 = createMockCoreV1Api();
    const pod = createMockPod({ name: "crash-pod", ready: false });
    (coreV1 as any).listPodForAllNamespaces.mockResolvedValue({ body: { items: [pod] } });

    const { app } = buildApp({ coreV1Override: coreV1 });
    const res = await app.inject({
      method: "GET",
      url: "/v1/pods",
      headers: authHeader(),
    });
    expect(res.json().items[0].ready).toBe(false);
    await app.close();
  });

  it("ready=false when pod has no conditions at all", async () => {
    const coreV1 = createMockCoreV1Api();
    const pod = {
      metadata: { namespace: "default", name: "no-cond", labels: {}, annotations: {} },
      spec: { containers: [{ name: "main" }], nodeName: "node-1" },
      status: { podIP: "10.0.0.1", phase: "Pending" },
    };
    (coreV1 as any).listPodForAllNamespaces.mockResolvedValue({ body: { items: [pod] } });

    const { app } = buildApp({ coreV1Override: coreV1 });
    const res = await app.inject({
      method: "GET",
      url: "/v1/pods",
      headers: authHeader(),
    });
    expect(res.json().items[0].ready).toBe(false);
    await app.close();
  });

  it("handles empty items list", async () => {
    const coreV1 = createMockCoreV1Api();
    (coreV1 as any).listPodForAllNamespaces.mockResolvedValue({ body: { items: [] } });

    const { app } = buildApp({ coreV1Override: coreV1 });
    const res = await app.inject({
      method: "GET",
      url: "/v1/pods",
      headers: authHeader(),
    });
    expect(res.json().items).toEqual([]);
    await app.close();
  });

  it("handles body with no items field (undefined)", async () => {
    const coreV1 = createMockCoreV1Api();
    (coreV1 as any).listPodForAllNamespaces.mockResolvedValue({ body: {} });

    const { app } = buildApp({ coreV1Override: coreV1 });
    const res = await app.inject({
      method: "GET",
      url: "/v1/pods",
      headers: authHeader(),
    });
    expect(res.json().items).toEqual([]);
    await app.close();
  });

  it("trims ns and selector query params", async () => {
    const coreV1 = createMockCoreV1Api();
    (coreV1 as any).listNamespacedPod.mockResolvedValue({ body: { items: [] } });

    const { app } = buildApp({ coreV1Override: coreV1 });
    await app.inject({
      method: "GET",
      url: "/v1/pods?ns=%20kube-system%20&selector=%20app%3Dnginx%20",
      headers: authHeader(),
    });
    const callArgs = (coreV1 as any).listNamespacedPod.mock.calls[0][0];
    expect(callArgs.namespace).toBe("kube-system");
    expect(callArgs.labelSelector).toBe("app=nginx");
    await app.close();
  });

  it("handles pod with missing optional fields gracefully", async () => {
    const coreV1 = createMockCoreV1Api();
    // Minimal pod with missing labels, annotations, containers, status fields
    const minimalPod = {
      metadata: { namespace: "ns", name: "minimal" },
      spec: {},
      status: {},
    };
    (coreV1 as any).listPodForAllNamespaces.mockResolvedValue({ body: { items: [minimalPod] } });

    const { app } = buildApp({ coreV1Override: coreV1 });
    const res = await app.inject({
      method: "GET",
      url: "/v1/pods",
      headers: authHeader(),
    });
    const item = res.json().items[0];
    expect(item.labels).toEqual({});
    expect(item.annotations).toEqual({});
    expect(item.containers).toEqual([]);
    expect(item.ready).toBe(false);
    expect(item.podIP).toBeUndefined();
    expect(item.nodeName).toBeUndefined();
    expect(item.phase).toBeUndefined();
    await app.close();
  });
});

describe("POST /v1/bundles", () => {
  const validBundleBody = {
    target: {
      namespace: "default",
      selector: "app=web",
    },
    timeWindow: {
      sinceSeconds: 300,
    },
  };

  it("requires auth — 401 without token", async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      payload: validBundleBody,
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("creates a bundle and returns bundleId and status", async () => {
    const bundleManager = createMockBundleManager();
    const { app } = buildApp({ bundleManagerOverride: bundleManager });

    const res = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeader(),
      payload: validBundleBody,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bundleId).toBe("bnd_test123");
    expect(body.status).toBe("queued");
    expect(bundleManager.create).toHaveBeenCalledOnce();
    await app.close();
  });

  it("creates a selector bundle for a matching scoped token with pods capability", async () => {
    const bundleManager = createMockBundleManager();
    const { app } = buildApp({ bundleManagerOverride: bundleManager });

    const res = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeader({ allowedNamespaces: ["default"], capabilities: ["pods", "logs", "events", "metrics"] }),
      payload: validBundleBody,
    });
    expect(res.statusCode).toBe(200);
    expect(bundleManager.create).toHaveBeenCalledOnce();
    await app.close();
  });

  it("rejects selector bundles when pods capability is missing", async () => {
    const bundleManager = createMockBundleManager();
    const { app } = buildApp({ bundleManagerOverride: bundleManager });

    const res = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeader({ allowedNamespaces: ["default"], capabilities: ["logs", "events", "metrics"] }),
      payload: validBundleBody,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
    expect(bundleManager.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects namespace wildcard bundles for scoped non-admin tokens", async () => {
    const bundleManager = createMockBundleManager();
    const { app } = buildApp({ bundleManagerOverride: bundleManager });

    const res = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeader({ allowedNamespaces: ["prod"], capabilities: ["pods", "logs", "events", "metrics"] }),
      payload: { target: { namespace: "*", selector: "app=web" } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
    expect(bundleManager.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects bundles when requested capability is missing", async () => {
    const bundleManager = createMockBundleManager();
    const { app } = buildApp({ bundleManagerOverride: bundleManager });

    const res = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeader({ allowedNamespaces: ["default"], capabilities: ["pods", "logs"] }),
      payload: {
        ...validBundleBody,
        include: { logs: { enabled: true }, events: { enabled: false }, metrics: { enabled: true } },
      },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
    expect(bundleManager.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns error code and message for HttpError from normalizeBundleRequest", async () => {
    const { app } = buildApp();
    // Send a non-object body (array) -> normalizeBundleRequest throws HttpError 400
    const res = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: JSON.stringify("a string body"),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("JSON object");
    await app.close();
  });

  it("returns 400 for missing target field", async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeader(),
      payload: { timeWindow: { sinceSeconds: 300 } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("target");
    await app.close();
  });

  it("returns 400 for body that is not a JSON object", async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: JSON.stringify([1, 2, 3]),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("JSON object");
    await app.close();
  });

  it("returns 500 for non-HttpError exceptions", async () => {
    const bundleManager = createMockBundleManager();
    bundleManager.create.mockRejectedValue(new Error("unexpected DB failure"));
    const { app } = buildApp({ bundleManagerOverride: bundleManager });

    const res = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeader(),
      payload: validBundleBody,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("internal_error");
    await app.close();
  });

  it("returns HttpError details when present", async () => {
    const bundleManager = createMockBundleManager();
    bundleManager.create.mockRejectedValue(
      new HttpError(429, "maxInflightBundles exceeded", { current: 5 }),
    );
    const { app } = buildApp({ bundleManagerOverride: bundleManager });

    const res = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeader(),
      payload: validBundleBody,
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe("maxInflightBundles exceeded");
    expect(res.json().details).toEqual({ current: 5 });
    await app.close();
  });
});

describe("GET /v1/bundles/:bundleId", () => {
  it("requires auth — 401 without token", async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/bundles/bnd_123" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 404 for unknown bundleId", async () => {
    const bundleManager = createMockBundleManager();
    const { app } = buildApp({ bundleManagerOverride: bundleManager });

    const res = await app.inject({
      method: "GET",
      url: "/v1/bundles/bnd_unknown",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("bundle_not_found");
    await app.close();
  });

  it("returns job info when bundle exists", async () => {
    const bundleManager = createMockBundleManager();
    const job: BundleJob = {
      bundleId: "bnd_abc",
      status: "running",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:01Z",
      expiresAt: "2025-01-01T01:00:00Z",
      params: {} as any,
    };
    bundleManager.jobs.set("bnd_abc", job);

    const { app } = buildApp({ bundleManagerOverride: bundleManager });
    const res = await app.inject({
      method: "GET",
      url: "/v1/bundles/bnd_abc",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.bundleId).toBe("bnd_abc");
    expect(body.status).toBe("running");
    expect(body.artifact).toBeUndefined();
    expect(body.error).toBeUndefined();
    await app.close();
  });

  it("includes artifact when available", async () => {
    const bundleManager = createMockBundleManager();
    const job: BundleJob = {
      bundleId: "bnd_done",
      status: "done",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:05Z",
      expiresAt: "2025-01-01T01:00:00Z",
      params: {} as any,
      artifactPath: "/tmp/bnd_done.ndjson.gz",
      artifactSizeBytes: 1234,
    };
    bundleManager.jobs.set("bnd_done", job);

    const artifact: BundleArtifact = {
      filename: "bnd_done.ndjson.gz",
      contentType: "application/gzip",
      sizeBytes: 1234,
      expiresAt: job.expiresAt,
      downloadPath: "/v1/bundles/bnd_done/download",
    };
    bundleManager.artifacts.set("bnd_done", artifact);

    const { app } = buildApp({ bundleManagerOverride: bundleManager });
    const res = await app.inject({
      method: "GET",
      url: "/v1/bundles/bnd_done",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.artifact.filename).toBe("bnd_done.ndjson.gz");
    expect(body.artifact.sizeBytes).toBe(1234);
    await app.close();
  });

  it("includes error when job has failed", async () => {
    const bundleManager = createMockBundleManager();
    const job: BundleJob = {
      bundleId: "bnd_fail",
      status: "failed",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:03Z",
      expiresAt: "2025-01-01T01:00:00Z",
      params: {} as any,
      error: "pod not found",
    };
    bundleManager.jobs.set("bnd_fail", job);

    const { app } = buildApp({ bundleManagerOverride: bundleManager });
    const res = await app.inject({
      method: "GET",
      url: "/v1/bundles/bnd_fail",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe("failed");
    expect(body.error).toBe("pod not found");
    await app.close();
  });
});

describe("GET /v1/bundles/:bundleId/download", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `test-bundle-${Date.now()}.ndjson.gz`);
    fs.writeFileSync(tmpFile, "fake-gzip-data-for-testing");
  });

  afterEach(() => {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore
    }
  });

  it("requires auth — 401 without token", async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/bundles/bnd_123/download" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 404 for unknown bundleId", async () => {
    const bundleManager = createMockBundleManager();
    const { app } = buildApp({ bundleManagerOverride: bundleManager });

    const res = await app.inject({
      method: "GET",
      url: "/v1/bundles/bnd_nonexistent/download",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("bundle_not_found");
    await app.close();
  });

  it("returns 409 when job status is not done", async () => {
    const bundleManager = createMockBundleManager();
    const job: BundleJob = {
      bundleId: "bnd_running",
      status: "running",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:01Z",
      expiresAt: "2025-01-01T01:00:00Z",
      params: {} as any,
    };
    bundleManager.jobs.set("bnd_running", job);

    const { app } = buildApp({ bundleManagerOverride: bundleManager });
    const res = await app.inject({
      method: "GET",
      url: "/v1/bundles/bnd_running/download",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("bundle_not_ready");
    await app.close();
  });

  it("returns 403 when token cannot access the bundle scope", async () => {
    const bundleManager = createMockBundleManager();
    const job: BundleJob<NormalizedBundleRequest> = {
      bundleId: "bnd_prod",
      status: "done",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:05Z",
      expiresAt: "2025-01-01T01:00:00Z",
      params: {
        timeWindow: { kind: "relative", sinceSeconds: 300 },
        target: { kind: "selector", namespace: "prod", selector: "app=web" },
        include: {
          logs: { enabled: true, tailLines: 100, previous: false, timestamps: true, excludePatterns: [] },
          events: { enabled: false },
          metrics: { enabled: false },
        },
        limits: {
          maxPods: 20,
          maxTotalLogLines: 50_000,
          sinceSecondsMax: 3600,
          maxMetricsPods: 20,
          metricsTimeoutMs: 2000,
          metricsConcurrency: 10,
        },
      },
      artifactPath: tmpFile,
    };
    bundleManager.jobs.set("bnd_prod", job);

    const { app } = buildApp({ bundleManagerOverride: bundleManager });
    const res = await app.inject({
      method: "GET",
      url: "/v1/bundles/bnd_prod/download",
      headers: authHeader({ allowedNamespaces: ["dev"], capabilities: ["logs"] }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
    await app.close();
  });

  it("returns 409 when job is done but has no artifactPath", async () => {
    const bundleManager = createMockBundleManager();
    const job: BundleJob = {
      bundleId: "bnd_no_path",
      status: "done",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:02Z",
      expiresAt: "2025-01-01T01:00:00Z",
      params: {} as any,
      // no artifactPath
    };
    bundleManager.jobs.set("bnd_no_path", job);

    const { app } = buildApp({ bundleManagerOverride: bundleManager });
    const res = await app.inject({
      method: "GET",
      url: "/v1/bundles/bnd_no_path/download",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("bundle_not_ready");
    await app.close();
  });

  it("returns 410 when artifact file no longer exists on disk", async () => {
    const bundleManager = createMockBundleManager();
    const job: BundleJob = {
      bundleId: "bnd_gone",
      status: "done",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:02Z",
      expiresAt: "2025-01-01T01:00:00Z",
      params: {} as any,
      artifactPath: "/tmp/non-existent-file-abc123.ndjson.gz",
    };
    bundleManager.jobs.set("bnd_gone", job);

    const { app } = buildApp({ bundleManagerOverride: bundleManager });
    const res = await app.inject({
      method: "GET",
      url: "/v1/bundles/bnd_gone/download",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(410);
    expect(res.json().error).toBe("bundle_artifact_gone");
    await app.close();
  });

  it("returns gzip stream with correct headers when artifact exists", async () => {
    const bundleManager = createMockBundleManager();
    const job: BundleJob = {
      bundleId: "bnd_ready",
      status: "done",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:05Z",
      expiresAt: "2025-01-01T01:00:00Z",
      params: {} as any,
      artifactPath: tmpFile,
    };
    bundleManager.jobs.set("bnd_ready", job);

    const { app } = buildApp({ bundleManagerOverride: bundleManager });
    const res = await app.inject({
      method: "GET",
      url: "/v1/bundles/bnd_ready/download",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/gzip");
    expect(res.headers["content-disposition"]).toBe('attachment; filename="bnd_ready.ndjson.gz"');
    expect(res.headers["cache-control"]).toBe("no-store");

    const fileSize = fs.statSync(tmpFile).size;
    expect(res.headers["content-length"]).toBe(String(fileSize));
    expect(res.body).toBe("fake-gzip-data-for-testing");
    await app.close();
  });

  it("returns 409 for queued job", async () => {
    const bundleManager = createMockBundleManager();
    const job: BundleJob = {
      bundleId: "bnd_queued",
      status: "queued",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:00Z",
      expiresAt: "2025-01-01T01:00:00Z",
      params: {} as any,
    };
    bundleManager.jobs.set("bnd_queued", job);

    const { app } = buildApp({ bundleManagerOverride: bundleManager });
    const res = await app.inject({
      method: "GET",
      url: "/v1/bundles/bnd_queued/download",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("bundle_not_ready");
    await app.close();
  });

  it("returns 409 for failed job", async () => {
    const bundleManager = createMockBundleManager();
    const job: BundleJob = {
      bundleId: "bnd_failed",
      status: "failed",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:03Z",
      expiresAt: "2025-01-01T01:00:00Z",
      params: {} as any,
      error: "something went wrong",
    };
    bundleManager.jobs.set("bnd_failed", job);

    const { app } = buildApp({ bundleManagerOverride: bundleManager });
    const res = await app.inject({
      method: "GET",
      url: "/v1/bundles/bnd_failed/download",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("bundle_not_ready");
    await app.close();
  });
});
