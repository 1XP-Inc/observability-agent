export type OALimits = {
  maxPods: number;
  maxTotalLogLines: number;
  sinceSecondsMax: number;
  maxMetricsPods: number;
  metricsConcurrency: number;
  metricsTimeoutMs: number;
};

export type OAConfig = {
  port: number;
  jwtSecret: string;
  jwtIss?: string;
  jwtAud?: string;

  bundleDir: string;
  bundleTtlMs: number;
  cleanupIntervalMs: number;

  maxInflightBundles: number;
  hardLimits: OALimits;

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

export function loadConfig(): OAConfig {
  const jwtSecret = envString("OA_JWT_SECRET");
  if (!jwtSecret) {
    throw new Error("Missing required env: OA_JWT_SECRET");
  }

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

  return {
    port,
    jwtSecret,
    jwtIss: envString("OA_JWT_ISS"),
    jwtAud: envString("OA_JWT_AUD"),

    bundleDir: envString("OA_BUNDLE_DIR") ?? "/tmp/oa-bundles",
    bundleTtlMs: bundleTtlMinutes * 60_000,
    cleanupIntervalMs,

    maxInflightBundles: envInt("OA_MAX_INFLIGHT_BUNDLES", 5),
    hardLimits,

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

