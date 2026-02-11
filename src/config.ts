import type { ServiceDef } from "./standalone/types";

export type OAMode = "k8s" | "standalone";

export type OALimits = {
  maxPods: number;
  maxTotalLogLines: number;
  sinceSecondsMax: number;
  maxMetricsPods: number;
  metricsConcurrency: number;
  metricsTimeoutMs: number;
};

export type OAConfig = {
  mode: OAMode;
  port: number;
  jwtSecret: string;
  jwtIss?: string;
  jwtAud?: string;

  bundleDir: string;
  bundleTtlMs: number;
  cleanupIntervalMs: number;

  maxInflightBundles: number;
  hardLimits: OALimits;

  allowedIps?: string[];
  trustProxy?: boolean | string;

  services?: ServiceDef[];

  defaults: {
    sinceSeconds: number;
    logs: {
      tailLines: number;
      previous: boolean;
      timestamps: boolean;
    };
    include: {
      logs: boolean;
      events: boolean;
      metrics: boolean;
    };
  };
};

function envString(name: string): string | undefined {
  const v = process.env[name];
  if (v == null) return undefined;
  const trimmed = v.trim();
  return trimmed.length ? trimmed : undefined;
}

function envInt(name: string, fallback: number): number {
  const v = envString(name);
  if (v == null) return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || Number.isNaN(n)) return fallback;
  return n;
}

function parseServices(): ServiceDef[] | undefined {
  const raw = envString("OA_SERVICES");
  if (!raw) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OA_SERVICES is not valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("OA_SERVICES must be a JSON array");
  }

  const services: ServiceDef[] = [];
  for (const [i, item] of parsed.entries()) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new Error(`OA_SERVICES[${i}] must be an object`);
    }
    if (typeof item.name !== "string" || !item.name.trim()) {
      throw new Error(`OA_SERVICES[${i}].name is required`);
    }
    const svc: ServiceDef = { name: item.name.trim() };
    if (item.logs != null) {
      if (!Array.isArray(item.logs)) {
        throw new Error(`OA_SERVICES[${i}].logs must be an array`);
      }
      svc.logs = item.logs.map((l: unknown, j: number) => {
        if (typeof l !== "string" || !l.trim()) {
          throw new Error(`OA_SERVICES[${i}].logs[${j}] must be a non-empty string`);
        }
        return l.trim();
      });
    }
    if (item.metrics != null) {
      if (typeof item.metrics !== "string" || !item.metrics.trim()) {
        throw new Error(`OA_SERVICES[${i}].metrics must be a non-empty string`);
      }
      svc.metrics = item.metrics.trim();
    }
    services.push(svc);
  }

  const names = new Set<string>();
  for (const s of services) {
    if (names.has(s.name)) {
      throw new Error(`Duplicate service name: ${s.name}`);
    }
    names.add(s.name);
  }

  return services;
}

export function loadConfig(): OAConfig {
  const jwtSecret = envString("OA_JWT_SECRET");
  if (!jwtSecret) {
    throw new Error("Missing required env: OA_JWT_SECRET");
  }

  const mode: OAMode = envString("KUBERNETES_SERVICE_HOST") ? "k8s" : "standalone";

  const port = envInt("OA_PORT", 8080);

  const hardLimits: OALimits = {
    maxPods: envInt("OA_MAX_PODS", 20),
    maxTotalLogLines: envInt("OA_MAX_TOTAL_LOG_LINES", 50_000),
    sinceSecondsMax: envInt("OA_SINCE_SECONDS_MAX", 3600),
    maxMetricsPods: envInt("OA_MAX_METRICS_PODS", 20),
    metricsConcurrency: envInt("OA_METRICS_CONCURRENCY", 10),
    metricsTimeoutMs: envInt("OA_METRICS_TIMEOUT_MS", 2000),
  };

  const bundleTtlMinutes = envInt("OA_BUNDLE_TTL_MINUTES", 60);
  const cleanupIntervalMs = envInt("OA_CLEANUP_INTERVAL_MS", 120_000);

  const allowedIpsRaw = envString("OA_ALLOWED_IPS");
  const allowedIps = allowedIpsRaw
    ? allowedIpsRaw.split(",").map(s => s.trim()).filter(Boolean)
    : undefined;

  const trustProxyRaw = envString("OA_TRUST_PROXY");
  const trustProxy = trustProxyRaw === "true" ? true : trustProxyRaw ?? undefined;

  const services = parseServices();
  if (mode === "standalone" && !services) {
    throw new Error("OA_SERVICES is required in standalone mode");
  }

  return {
    mode,
    port,
    jwtSecret,
    jwtIss: envString("OA_JWT_ISS"),
    jwtAud: envString("OA_JWT_AUD"),

    bundleDir: envString("OA_BUNDLE_DIR") ?? "/tmp/oa-bundles",
    bundleTtlMs: bundleTtlMinutes * 60_000,
    cleanupIntervalMs,

    maxInflightBundles: envInt("OA_MAX_INFLIGHT_BUNDLES", 5),
    hardLimits,

    allowedIps,
    trustProxy,

    services,

    defaults: {
      sinceSeconds: envInt("OA_DEFAULT_SINCE_SECONDS", 600),
      logs: {
        tailLines: envInt("OA_DEFAULT_TAIL_LINES", 2000),
        previous: (envString("OA_DEFAULT_LOG_PREVIOUS") ?? "true") === "true",
        timestamps: (envString("OA_DEFAULT_LOG_TIMESTAMPS") ?? "true") === "true",
      },
      include: {
        logs: (envString("OA_DEFAULT_INCLUDE_LOGS") ?? "true") === "true",
        events: (envString("OA_DEFAULT_INCLUDE_EVENTS") ?? "true") === "true",
        metrics: (envString("OA_DEFAULT_INCLUDE_METRICS") ?? "true") === "true",
      },
    },
  };
}
