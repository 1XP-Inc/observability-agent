import type { OAConfig } from "../config";
import { HttpError } from "../http-error";
import type { ServiceDef, StandaloneNormalizedRequest } from "./types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asInt(name: string, v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim().length) {
    const n = Number.parseInt(v, 10);
    if (Number.isFinite(n) && !Number.isNaN(n)) return n;
  }
  throw new HttpError(400, `Invalid integer: ${name}`);
}

function asBool(name: string, v: unknown): boolean | undefined {
  if (v == null) return undefined;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (v === "true") return true;
    if (v === "false") return false;
  }
  throw new HttpError(400, `Invalid boolean: ${name}`);
}

function asStringArray(name: string, v: unknown): string[] | undefined {
  if (v == null) return undefined;
  if (!Array.isArray(v)) throw new HttpError(400, `Invalid array: ${name}`);
  const out: string[] = [];
  for (const [i, item] of v.entries()) {
    if (typeof item !== "string") throw new HttpError(400, `Invalid string: ${name}[${i}]`);
    const s = item.trim();
    if (s) out.push(s);
  }
  return out;
}

function parseIso8601Z(name: string, v: unknown): { iso: string; ms: number } {
  if (typeof v !== "string") throw new HttpError(400, `Invalid string: ${name}`);
  const iso = v.trim();
  if (!iso.endsWith("Z")) {
    throw new HttpError(400, `${name} must be ISO8601 UTC (end with 'Z')`);
  }
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || Number.isNaN(ms)) throw new HttpError(400, `Invalid datetime: ${name}`);
  return { iso, ms };
}

function clampLimit(name: string, value: number, hardMax: number, min: number = 1): number {
  /* c8 ignore start -- defensive guard; asInt() already validates finiteness */
  if (!Number.isFinite(value) || Number.isNaN(value)) {
    throw new HttpError(400, `Invalid number: ${name}`);
  }
  /* c8 ignore stop */
  if (value < min) throw new HttpError(400, `${name} must be >= ${min}`);
  if (value > hardMax) {
    throw new HttpError(400, `${name} exceeds hard limit (${value} > ${hardMax})`);
  }
  return value;
}

export type StandaloneBundleRequest = {
  timeWindow?: {
    sinceSeconds?: number;
    start?: string;
    end?: string;
  };
  target?: {
    kind?: string;
    services?: string[];
  };
  include?: {
    logs?: { enabled?: boolean; includePatterns?: string[]; excludePatterns?: string[] };
    metrics?: { enabled?: boolean };
  };
  limits?: {
    maxTotalLogLines?: number;
    sinceSecondsMax?: number;
    metricsTimeoutMs?: number;
  };
};

export function normalizeStandaloneBundleRequest(
  input: unknown,
  config: OAConfig,
  knownServices: ServiceDef[],
): StandaloneNormalizedRequest {
  if (!isRecord(input)) throw new HttpError(400, "Body must be a JSON object");
  const body = input as StandaloneBundleRequest;

  // --- timeWindow ---
  const timeWindowObj = isRecord(body.timeWindow) ? body.timeWindow : undefined;
  const limitsObj = isRecord(body.limits) ? body.limits : undefined;

  const effSinceSecondsMax = clampLimit(
    "limits.sinceSecondsMax",
    asInt("limits.sinceSecondsMax", limitsObj?.sinceSecondsMax) ?? config.hardLimits.sinceSecondsMax,
    config.hardLimits.sinceSecondsMax,
    1,
  );

  const hasSinceSeconds = timeWindowObj?.sinceSeconds != null;
  const hasAbs = timeWindowObj?.start != null || timeWindowObj?.end != null;
  if (hasSinceSeconds && hasAbs) {
    throw new HttpError(400, "timeWindow cannot use sinceSeconds together with start/end");
  }

  let timeWindow: StandaloneNormalizedRequest["timeWindow"];
  if (hasAbs) {
    if (timeWindowObj?.start == null || timeWindowObj?.end == null) {
      throw new HttpError(400, "timeWindow.start and timeWindow.end are required together");
    }
    const start = parseIso8601Z("timeWindow.start", timeWindowObj.start);
    const end = parseIso8601Z("timeWindow.end", timeWindowObj.end);
    if (end.ms < start.ms) throw new HttpError(400, "timeWindow.end must be >= timeWindow.start");
    const windowSec = Math.ceil((end.ms - start.ms) / 1000);
    if (windowSec > effSinceSecondsMax) {
      throw new HttpError(400, `timeWindow range exceeds sinceSecondsMax (${windowSec} > ${effSinceSecondsMax})`);
    }
    timeWindow = { kind: "absolute", start: start.iso, end: end.iso };
  } else {
    const sinceSeconds = clampLimit(
      "timeWindow.sinceSeconds",
      asInt("timeWindow.sinceSeconds", timeWindowObj?.sinceSeconds) ?? config.defaults.sinceSeconds,
      effSinceSecondsMax,
      1,
    );
    timeWindow = { kind: "relative", sinceSeconds };
  }

  // --- target ---
  const targetObj = isRecord(body.target) ? body.target : undefined;
  if (!targetObj) throw new HttpError(400, "Missing required field: target");

  const serviceNames = asStringArray("target.services", targetObj.services);
  const knownNames = new Set(knownServices.map((s) => s.name));

  let target: StandaloneNormalizedRequest["target"];
  if (targetObj.kind === "services" || serviceNames) {
    if (!serviceNames || serviceNames.length === 0) {
      throw new HttpError(400, "target.services must be a non-empty array");
    }
    for (const svc of serviceNames) {
      if (!knownNames.has(svc)) {
        throw new HttpError(400, `Unknown service: ${svc}`);
      }
    }
    target = { kind: "services", services: serviceNames };
  } else {
    throw new HttpError(400, "target.kind must be 'services' with a services[] array");
  }

  // --- include ---
  const includeObj = isRecord(body.include) ? body.include : undefined;
  const logsObj = isRecord(includeObj?.logs) ? includeObj?.logs : undefined;
  const metricsObj = isRecord(includeObj?.metrics) ? includeObj?.metrics : undefined;

  const includeLogs = asBool("include.logs.enabled", logsObj?.enabled) ?? config.defaults.include.logs;
  const includeMetrics = asBool("include.metrics.enabled", metricsObj?.enabled) ?? config.defaults.include.metrics;

  const includePatterns = asStringArray("include.logs.includePatterns", logsObj?.includePatterns) ?? [];
  if (includePatterns.length > 50) {
    throw new HttpError(400, "include.logs.includePatterns too large (max 50)");
  }
  for (const p of includePatterns) {
    if (p.length > 200) throw new HttpError(400, "include.logs.includePatterns item too long (max 200)");
  }

  const excludePatterns = asStringArray("include.logs.excludePatterns", logsObj?.excludePatterns) ?? [];
  if (excludePatterns.length > 50) {
    throw new HttpError(400, "include.logs.excludePatterns too large (max 50)");
  }
  for (const p of excludePatterns) {
    if (p.length > 200) throw new HttpError(400, "include.logs.excludePatterns item too long (max 200)");
  }

  // --- limits ---
  const effMaxTotalLogLines = clampLimit(
    "limits.maxTotalLogLines",
    asInt("limits.maxTotalLogLines", limitsObj?.maxTotalLogLines) ?? config.hardLimits.maxTotalLogLines,
    config.hardLimits.maxTotalLogLines,
    1,
  );
  const effMetricsTimeoutMs = clampLimit(
    "limits.metricsTimeoutMs",
    asInt("limits.metricsTimeoutMs", limitsObj?.metricsTimeoutMs) ?? config.hardLimits.metricsTimeoutMs,
    config.hardLimits.metricsTimeoutMs,
    1,
  );

  return {
    timeWindow,
    target,
    include: {
      logs: { enabled: includeLogs, includePatterns, excludePatterns },
      metrics: { enabled: includeMetrics },
    },
    limits: {
      maxTotalLogLines: effMaxTotalLogLines,
      sinceSecondsMax: effSinceSecondsMax,
      metricsTimeoutMs: effMetricsTimeoutMs,
    },
  };
}
