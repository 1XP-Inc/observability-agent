import type { OAConfig } from "../config";
import { HttpError } from "../http-error";
import type { ServiceDef, StandaloneNormalizedRequest } from "./types";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function optionalRecordChild(
  parent: Record<string, unknown> | undefined,
  key: string,
  name: string,
): Record<string, unknown> | undefined {
  if (!parent || !Object.prototype.hasOwnProperty.call(parent, key)) return undefined;
  const v = parent[key];
  if (!isRecord(v)) throw new HttpError(400, `Invalid object: ${name}`);
  return v;
}

function asInt(name: string, v: unknown): number | undefined {
  if (v == null) return undefined;
  if (typeof v === "number" && Number.isSafeInteger(v)) return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (/^[+-]?\d+$/.test(s)) {
      const n = Number(s);
      if (Number.isSafeInteger(n)) return n;
    }
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

function parseIso8601Z(name: string, v: unknown): { iso: string; ms: number; epochNs: bigint } {
  if (typeof v !== "string") throw new HttpError(400, `Invalid string: ${name}`);
  const iso = v.trim();
  if (!iso.endsWith("Z")) {
    throw new HttpError(400, `${name} must be ISO8601 UTC (end with 'Z')`);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?Z$/.exec(iso);
  if (!match) throw new HttpError(400, `Invalid datetime: ${name}`);
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || Number.isNaN(ms)) throw new HttpError(400, `Invalid datetime: ${name}`);
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, fractionRaw] = match;
  const d = new Date(ms);
  if (
    d.getUTCFullYear() !== Number(yearRaw) ||
    d.getUTCMonth() + 1 !== Number(monthRaw) ||
    d.getUTCDate() !== Number(dayRaw) ||
    d.getUTCHours() !== Number(hourRaw) ||
    d.getUTCMinutes() !== Number(minuteRaw) ||
    d.getUTCSeconds() !== Number(secondRaw)
  ) {
    throw new HttpError(400, `Invalid datetime: ${name}`);
  }
  const wholeSecondMs = Date.UTC(
    Number(yearRaw),
    Number(monthRaw) - 1,
    Number(dayRaw),
    Number(hourRaw),
    Number(minuteRaw),
    Number(secondRaw),
  );
  const fractionNs = BigInt((fractionRaw ?? "").padEnd(9, "0") || "0");
  return {
    iso,
    ms,
    epochNs: BigInt(wholeSecondMs) * 1_000_000n + fractionNs,
  };
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
    logs?: { enabled?: boolean; tailLines?: number; includePatterns?: string[]; excludePatterns?: string[] };
    metrics?: { enabled?: boolean };
  };
  limits?: {
    maxTotalLogLines?: number;
    sinceSecondsMax?: number;
    metricsTimeoutMs?: number;
  };
};

function selectedServicesForRequest(req: StandaloneNormalizedRequest, services: ServiceDef[]): ServiceDef[] {
  if (req.target.kind === "all") return services;
  const selected = new Set(req.target.services);
  return services.filter((svc) => selected.has(svc.name));
}

export function assertStandaloneTargetServicesKnown(req: StandaloneNormalizedRequest, services: ServiceDef[]): void {
  if (req.target.kind === "all") return;
  const known = new Set(services.map((svc) => svc.name));
  for (const serviceName of req.target.services) {
    if (!known.has(serviceName)) {
      throw new HttpError(400, `Unknown service: ${serviceName}`);
    }
  }
}

export function assertStandaloneLogSourceConstraints(req: StandaloneNormalizedRequest, services: ServiceDef[]): void {
  if (!req.include.logs.enabled || !req.timeWindow) return;
  const hasJournalSource = selectedServicesForRequest(req, services).some((svc) => Boolean(svc.journal));
  if (!hasJournalSource) {
    throw new HttpError(400, "timeWindow is only supported for selected journal log sources");
  }
}

export function normalizeStandaloneBundleRequest(
  input: unknown,
  config: OAConfig,
  knownServices: ServiceDef[],
): StandaloneNormalizedRequest {
  if (!isRecord(input)) throw new HttpError(400, "Body must be a JSON object");
  const body = input as StandaloneBundleRequest;

  const limitsObj = isRecord(body.limits) ? body.limits : undefined;

  // --- limits ---
  const effMaxTotalLogLines = clampLimit(
    "limits.maxTotalLogLines",
    asInt("limits.maxTotalLogLines", limitsObj?.maxTotalLogLines) ?? config.hardLimits.maxTotalLogLines,
    config.hardLimits.maxTotalLogLines,
    1,
  );
  const effSinceSecondsMax = clampLimit(
    "limits.sinceSecondsMax",
    asInt("limits.sinceSecondsMax", limitsObj?.sinceSecondsMax) ?? config.hardLimits.sinceSecondsMax,
    config.hardLimits.sinceSecondsMax,
    1,
  );
  const effMetricsTimeoutMs = clampLimit(
    "limits.metricsTimeoutMs",
    asInt("limits.metricsTimeoutMs", limitsObj?.metricsTimeoutMs) ?? config.hardLimits.metricsTimeoutMs,
    config.hardLimits.metricsTimeoutMs,
    1,
  );

  // --- target ---
  const targetObj = isRecord(body.target) ? body.target : undefined;
  if (!targetObj) throw new HttpError(400, "Missing required field: target");

  const serviceNames = asStringArray("target.services", targetObj.services);

  let target: StandaloneNormalizedRequest["target"];
  if (targetObj.kind === "all") {
    if (serviceNames && serviceNames.length > 0) {
      throw new HttpError(400, "target.services cannot be used with target.kind 'all'");
    }
    target = { kind: "all" };
  } else if (targetObj.kind === "services" || serviceNames) {
    if (!serviceNames || serviceNames.length === 0) {
      throw new HttpError(400, "target.services must be a non-empty array");
    }
    target = { kind: "services", services: serviceNames };
  } else {
    throw new HttpError(400, "target.kind must be 'services' with a services[] array or 'all'");
  }

  // --- include ---
  const includeObj = isRecord(body.include) ? body.include : undefined;
  const logsObj = optionalRecordChild(includeObj, "logs", "include.logs");
  optionalRecordChild(includeObj, "events", "include.events");
  const metricsObj = optionalRecordChild(includeObj, "metrics", "include.metrics");

  const includeLogs = asBool("include.logs.enabled", logsObj?.enabled) ?? config.defaults.include.logs;
  const includeMetrics = asBool("include.metrics.enabled", metricsObj?.enabled) ?? config.defaults.include.metrics;

  const tailLines = clampLimit(
    "include.logs.tailLines",
    asInt("include.logs.tailLines", logsObj?.tailLines) ?? config.defaults.logs.tailLines,
    config.hardLimits.maxTotalLogLines,
    0,
  );

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

  // --- timeWindow ---
  if (body.timeWindow != null && !isRecord(body.timeWindow)) {
    throw new HttpError(400, "Invalid object: timeWindow");
  }
  const timeWindowObj = isRecord(body.timeWindow) ? body.timeWindow : undefined;

  const hasSinceSeconds = timeWindowObj?.sinceSeconds != null;
  const hasAbs = timeWindowObj?.start != null || timeWindowObj?.end != null;
  if (hasSinceSeconds && hasAbs) {
    throw new HttpError(400, "timeWindow cannot use sinceSeconds together with start/end");
  }

  let timeWindow: StandaloneNormalizedRequest["timeWindow"];
  if (!timeWindowObj) {
    timeWindow = undefined;
  } else if (!hasSinceSeconds && !hasAbs) {
    throw new HttpError(400, "timeWindow must include sinceSeconds or start/end");
  } else if (hasAbs) {
    if (timeWindowObj?.start == null || timeWindowObj?.end == null) {
      throw new HttpError(400, "timeWindow.start and timeWindow.end are required together");
    }
    const start = parseIso8601Z("timeWindow.start", timeWindowObj.start);
    const end = parseIso8601Z("timeWindow.end", timeWindowObj.end);
    if (end.epochNs < start.epochNs) throw new HttpError(400, "timeWindow.end must be >= timeWindow.start");
    const windowSec = Number((end.epochNs - start.epochNs + 999_999_999n) / 1_000_000_000n);
    if (windowSec > effSinceSecondsMax) {
      throw new HttpError(400, `timeWindow range exceeds sinceSecondsMax (${windowSec} > ${effSinceSecondsMax})`);
    }
    timeWindow = { kind: "absolute", start: start.iso, end: end.iso };
  } else {
    const sinceSecondsRaw = asInt("timeWindow.sinceSeconds", timeWindowObj.sinceSeconds);
    if (sinceSecondsRaw == null) {
      throw new HttpError(400, "timeWindow must include sinceSeconds or start/end");
    }
    const sinceSeconds = clampLimit(
      "timeWindow.sinceSeconds",
      sinceSecondsRaw,
      effSinceSecondsMax,
      1,
    );
    timeWindow = { kind: "relative", sinceSeconds };
  }

  return {
    timeWindow,
    target,
    include: {
      logs: { enabled: includeLogs, tailLines, includePatterns, excludePatterns },
      metrics: { enabled: includeMetrics },
    },
    limits: {
      maxTotalLogLines: effMaxTotalLogLines,
      sinceSecondsMax: effSinceSecondsMax,
      metricsTimeoutMs: effMetricsTimeoutMs,
    },
  };
}
