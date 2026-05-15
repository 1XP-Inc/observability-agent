import { vi } from "vitest";
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { authHook } from "../../src/auth";
import { registerStandaloneRoutes } from "../../src/standalone/routes";
import { createMockConfig } from "../helpers";
import type { BundleJob, BundleArtifact } from "../../src/types";
import type { ServiceDef, StandaloneNormalizedRequest } from "../../src/standalone/types";

const SECRET = "test-secret-key-for-testing-hs256";
const services: ServiceDef[] = [
  { name: "solana-validator", logs: ["/var/log/solana/validator.log"], journal: "sol.service", metrics: "http://localhost:9090/metrics" },
  { name: "rpc-node", logs: ["/var/log/solana/rpc.log"] },
  { name: "beacond", journal: "bera-beacond.service", journalScope: "user", journalUser: "ubuntu" },
];

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

function createMockBundleManager() {
  const jobs = new Map<string, BundleJob<StandaloneNormalizedRequest>>();
  const artifacts = new Map<string, BundleArtifact>();

  return {
    jobs,
    artifacts,
    create: vi.fn(async (params: StandaloneNormalizedRequest): Promise<BundleJob<StandaloneNormalizedRequest>> => {
      const job: BundleJob<StandaloneNormalizedRequest> = {
        bundleId: "bnd_standalone_123",
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

function buildApp(opts?: { bundleManagerOverride?: ReturnType<typeof createMockBundleManager> }) {
  const config = createMockConfig({ mode: "standalone", jwtSecret: SECRET, services });
  const bundles = opts?.bundleManagerOverride ?? createMockBundleManager();

  const app = Fastify({ logger: false, bodyLimit: 1_000_000 });
  app.get("/healthz", async () => ({ ok: true }));
  app.addHook("onRequest", authHook(config));
  registerStandaloneRoutes(app, { config, services, bundles });

  return { app, config, bundles };
}

describe("GET /v1/services", () => {
  it("returns service list", async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/services",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.items).toHaveLength(3);
    expect(body.items[0]).toEqual({
      name: "solana-validator",
      logs: ["/var/log/solana/validator.log"],
      journal: "sol.service",
      metrics: "http://localhost:9090/metrics",
    });
    expect(body.items[1]).toEqual({
      name: "rpc-node",
      logs: ["/var/log/solana/rpc.log"],
      journal: null,
      metrics: null,
    });
    expect(body.items[2]).toEqual({
      name: "beacond",
      logs: [],
      journal: "bera-beacond.service",
      journalScope: "user",
      journalUser: "ubuntu",
      metrics: null,
    });
    await app.close();
  });

  it("requires auth", async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: "GET", url: "/v1/services" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("filters services and redacts sensitive fields for scoped tokens", async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/services",
      headers: authHeader({ allowedServices: ["rpc-*"], capabilities: ["logs"] }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([{ name: "rpc-node" }]);
    await app.close();
  });

  it("allows wildcard service scopes for non-admin tokens", async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/services",
      headers: authHeader({ allowedServices: ["*"], capabilities: ["logs"] }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toEqual([{ name: "solana-validator" }, { name: "rpc-node" }, { name: "beacond" }]);
    await app.close();
  });

  it("preserves full service details for legacy tokens without authorization claims", async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/services",
      headers: { authorization: `Bearer ${validToken({})}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items[0]).toEqual({
      name: "solana-validator",
      logs: ["/var/log/solana/validator.log"],
      journal: "sol.service",
      metrics: "http://localhost:9090/metrics",
    });
    await app.close();
  });
});

describe("POST /v1/bundles (standalone)", () => {
  const validBody = {
    target: { kind: "services", services: ["solana-validator"] },
    timeWindow: { sinceSeconds: 300 },
  };

  it("creates a bundle", async () => {
    const bundleManager = createMockBundleManager();
    const { app } = buildApp({ bundleManagerOverride: bundleManager });

    const res = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeader(),
      payload: validBody,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().bundleId).toBe("bnd_standalone_123");
    expect(res.json().status).toBe("queued");
    expect(bundleManager.create).toHaveBeenCalledOnce();
    await app.close();
  });

  it("creates a bundle for a matching service scope and capabilities", async () => {
    const bundleManager = createMockBundleManager();
    const { app } = buildApp({ bundleManagerOverride: bundleManager });

    const res = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeader({ allowedServices: ["solana-*"], capabilities: ["logs", "metrics"] }),
      payload: validBody,
    });
    expect(res.statusCode).toBe(200);
    expect(bundleManager.create).toHaveBeenCalledOnce();
    await app.close();
  });

  it("rejects a bundle for a service outside the token scope", async () => {
    const bundleManager = createMockBundleManager();
    const { app } = buildApp({ bundleManagerOverride: bundleManager });

    const res = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeader({ allowedServices: ["rpc-*"], capabilities: ["logs", "metrics"] }),
      payload: validBody,
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
    expect(bundleManager.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects a bundle when requested capability is missing", async () => {
    const bundleManager = createMockBundleManager();
    const { app } = buildApp({ bundleManagerOverride: bundleManager });

    const res = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeader({ allowedServices: ["solana-*"], capabilities: ["logs"] }),
      payload: { ...validBody, include: { logs: { enabled: true }, metrics: { enabled: true } } },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
    expect(bundleManager.create).not.toHaveBeenCalled();
    await app.close();
  });

  it("returns 400 for invalid body", async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: { ...authHeader(), "content-type": "application/json" },
      payload: JSON.stringify("not-object"),
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it("returns 400 for unknown service", async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeader(),
      payload: { target: { kind: "services", services: ["unknown"] } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain("Unknown service");
    await app.close();
  });

  it("returns 500 for unexpected errors", async () => {
    const bundleManager = createMockBundleManager();
    bundleManager.create.mockRejectedValue(new Error("unexpected"));
    const { app } = buildApp({ bundleManagerOverride: bundleManager });

    const res = await app.inject({
      method: "POST",
      url: "/v1/bundles",
      headers: authHeader(),
      payload: validBody,
    });
    expect(res.statusCode).toBe(500);
    expect(res.json().error).toBe("internal_error");
    await app.close();
  });

  it("requires auth", async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: "POST", url: "/v1/bundles", payload: validBody });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe("GET /v1/bundles/:bundleId (standalone)", () => {
  it("returns 404 for unknown bundle", async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/bundles/bnd_unknown",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns job info", async () => {
    const bundleManager = createMockBundleManager();
    const job: BundleJob<StandaloneNormalizedRequest> = {
      bundleId: "bnd_sa",
      status: "running",
      createdAt: "2025-01-01T00:00:00Z",
      updatedAt: "2025-01-01T00:00:01Z",
      expiresAt: "2025-01-01T01:00:00Z",
      params: {} as any,
    };
    bundleManager.jobs.set("bnd_sa", job);
    const { app } = buildApp({ bundleManagerOverride: bundleManager });

    const res = await app.inject({
      method: "GET",
      url: "/v1/bundles/bnd_sa",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().bundleId).toBe("bnd_sa");
    expect(res.json().status).toBe("running");
    await app.close();
  });
});

describe("GET /v1/bundles/:bundleId/download (standalone)", () => {
  let tmpFile: string;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `sa-bundle-${Date.now()}.ndjson.gz`);
    fs.writeFileSync(tmpFile, "fake-data");
  });

  afterEach(() => {
    try { fs.unlinkSync(tmpFile); } catch {}
  });

  it("returns 404 for unknown bundle", async () => {
    const { app } = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/v1/bundles/bnd_unknown/download",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it("returns 409 when not done", async () => {
    const bundleManager = createMockBundleManager();
    bundleManager.jobs.set("bnd_run", {
      bundleId: "bnd_run",
      status: "running",
      createdAt: "", updatedAt: "", expiresAt: "",
      params: {} as any,
    });
    const { app } = buildApp({ bundleManagerOverride: bundleManager });

    const res = await app.inject({
      method: "GET",
      url: "/v1/bundles/bnd_run/download",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it("returns 403 when token cannot access the bundle service scope", async () => {
    const bundleManager = createMockBundleManager();
    bundleManager.jobs.set("bnd_scope", {
      bundleId: "bnd_scope",
      status: "done",
      createdAt: "",
      updatedAt: "",
      expiresAt: "",
      params: {
        timeWindow: { kind: "relative", sinceSeconds: 300 },
        target: { kind: "services", services: ["solana-validator"] },
        include: {
          logs: { enabled: true, excludePatterns: [] },
          metrics: { enabled: false },
        },
        limits: {
          maxTotalLogLines: 50_000,
          sinceSecondsMax: 3600,
          metricsTimeoutMs: 2000,
        },
      },
      artifactPath: tmpFile,
    });
    const { app } = buildApp({ bundleManagerOverride: bundleManager });

    const res = await app.inject({
      method: "GET",
      url: "/v1/bundles/bnd_scope/download",
      headers: authHeader({ allowedServices: ["rpc-*"], capabilities: ["logs"] }),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("forbidden");
    await app.close();
  });

  it("returns gzip stream when artifact exists", async () => {
    const bundleManager = createMockBundleManager();
    bundleManager.jobs.set("bnd_dl", {
      bundleId: "bnd_dl",
      status: "done",
      createdAt: "", updatedAt: "", expiresAt: "",
      params: {} as any,
      artifactPath: tmpFile,
    });
    const { app } = buildApp({ bundleManagerOverride: bundleManager });

    const res = await app.inject({
      method: "GET",
      url: "/v1/bundles/bnd_dl/download",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toBe("application/gzip");
    expect(res.body).toBe("fake-data");
    await app.close();
  });

  it("returns 410 when artifact file is gone", async () => {
    const bundleManager = createMockBundleManager();
    bundleManager.jobs.set("bnd_gone", {
      bundleId: "bnd_gone",
      status: "done",
      createdAt: "", updatedAt: "", expiresAt: "",
      params: {} as any,
      artifactPath: "/tmp/nonexistent-12345.ndjson.gz",
    });
    const { app } = buildApp({ bundleManagerOverride: bundleManager });

    const res = await app.inject({
      method: "GET",
      url: "/v1/bundles/bnd_gone/download",
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(410);
    await app.close();
  });
});

describe("GET /skill.md (standalone)", () => {
  it("returns markdown", async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: "GET", url: "/skill.md" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    await app.close();
  });
});

describe("GET /.well-known/skill.md (standalone)", () => {
  it("returns markdown", async () => {
    const { app } = buildApp();
    const res = await app.inject({ method: "GET", url: "/.well-known/skill.md" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/markdown");
    await app.close();
  });
});
