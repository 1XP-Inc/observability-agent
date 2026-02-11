import type { OAConfig } from "../config";
import type { BundleRequest, NormalizedBundleRequest } from "./types";
import { HttpError } from "../http-error";

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

function nonEmptyString(name: string, v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v !== "string") throw new HttpError(400, `Invalid string: ${name}`);
  const s = v.trim();
  if (!s) return undefined;
  return s;
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

function clampLimit(
  name: string,
  value: number,
  hardMax: number,
  min: number = 1,
): number {
  if (!Number.isFinite(value) || Number.isNaN(value)) {
    throw new HttpError(400, `Invalid number: ${name}`);
  }
  if (value < min) throw new HttpError(400, `${name} must be >= ${min}`);
  if (value > hardMax) {
    throw new HttpError(400, `${name} exceeds hard limit (${value} > ${hardMax})`);
  }
  return value;
}

export function normalizeBundleRequest(input: unknown, config: OAConfig): NormalizedBundleRequest {
  if (!isRecord(input)) throw new HttpError(400, "Body must be a JSON object");
  const body = input as BundleRequest;

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

  let timeWindow: NormalizedBundleRequest["timeWindow"];
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

  const effMaxPods = clampLimit(
    "limits.maxPods",
    asInt("limits.maxPods", limitsObj?.maxPods) ?? config.hardLimits.maxPods,
    config.hardLimits.maxPods,
    1,
  );
  const effMaxTotalLogLines = clampLimit(
    "limits.maxTotalLogLines",
    asInt("limits.maxTotalLogLines", limitsObj?.maxTotalLogLines) ?? config.hardLimits.maxTotalLogLines,
    config.hardLimits.maxTotalLogLines,
    1,
  );
  const effMaxMetricsPods = clampLimit(
    "limits.maxMetricsPods",
    asInt("limits.maxMetricsPods", limitsObj?.maxMetricsPods) ?? config.hardLimits.maxMetricsPods,
    config.hardLimits.maxMetricsPods,
    0,
  );
  const effMetricsTimeoutMs = clampLimit(
    "limits.metricsTimeoutMs",
    asInt("limits.metricsTimeoutMs", limitsObj?.metricsTimeoutMs) ?? config.hardLimits.metricsTimeoutMs,
    config.hardLimits.metricsTimeoutMs,
    1,
  );
  const effMetricsConcurrency = clampLimit(
    "limits.metricsConcurrency",
    asInt("limits.metricsConcurrency", limitsObj?.metricsConcurrency) ?? config.hardLimits.metricsConcurrency,
    config.hardLimits.metricsConcurrency,
    1,
  );

  const includeObj = isRecord(body.include) ? body.include : undefined;
  const logsObj = isRecord(includeObj?.logs) ? includeObj?.logs : undefined;
  const eventsObj = isRecord(includeObj?.events) ? includeObj?.events : undefined;
  const metricsObj = isRecord(includeObj?.metrics) ? includeObj?.metrics : undefined;

  const includeLogs = asBool("include.logs.enabled", logsObj?.enabled) ?? config.defaults.include.logs;
  const includeEvents = asBool("include.events.enabled", eventsObj?.enabled) ?? config.defaults.include.events;
  const includeMetrics = asBool("include.metrics.enabled", metricsObj?.enabled) ?? config.defaults.include.metrics;

  const tailLines = clampLimit(
    "include.logs.tailLines",
    asInt("include.logs.tailLines", logsObj?.tailLines) ?? config.defaults.logs.tailLines,
    effMaxTotalLogLines,
    0,
  );

  const previous = asBool("include.logs.previous", logsObj?.previous) ?? config.defaults.logs.previous;
  const timestampsRequested = asBool("include.logs.timestamps", logsObj?.timestamps) ?? config.defaults.logs.timestamps;
  const timestamps = timeWindow.kind === "absolute" ? true : timestampsRequested;

  const excludePatterns = asStringArray("include.logs.excludePatterns", logsObj?.excludePatterns) ?? [];
  if (excludePatterns.length > 50) {
    throw new HttpError(400, "include.logs.excludePatterns too large (max 50)");
  }
  for (const p of excludePatterns) {
    if (p.length > 200) throw new HttpError(400, "include.logs.excludePatterns item too long (max 200)");
  }

  const targetObj = isRecord(body.target) ? body.target : undefined;
  if (!targetObj) throw new HttpError(400, "Missing required field: target");

  const podsArr = Array.isArray(targetObj.pods) ? targetObj.pods : undefined;
  const namespace = nonEmptyString("target.namespace", targetObj.namespace) ?? "*";
  const selector = nonEmptyString("target.selector", targetObj.selector);

  const hasPods = !!(podsArr && podsArr.length);
  const hasSelectorMode = !!selector || (targetObj.namespace != null);

  if (hasPods && hasSelectorMode) {
    throw new HttpError(400, "target must use either namespace+selector OR pods[] (not both)");
  }

  let target: NormalizedBundleRequest["target"];
  if (hasPods) {
    const normalizedPods: Array<{ namespace: string; pod: string }> = [];
    for (const [i, p] of podsArr!.entries()) {
      if (!isRecord(p)) throw new HttpError(400, `target.pods[${i}] must be an object`);
      const pns = nonEmptyString(`target.pods[${i}].namespace`, p.namespace);
      const pod = nonEmptyString(`target.pods[${i}].pod`, p.pod);
      if (!pns || !pod) throw new HttpError(400, `target.pods[${i}] requires namespace and pod`);
      normalizedPods.push({ namespace: pns, pod });
    }
    if (normalizedPods.length > effMaxPods) {
      throw new HttpError(400, `target.pods exceeds maxPods (${normalizedPods.length} > ${effMaxPods})`);
    }
    target = { kind: "pods", pods: normalizedPods };
  } else {
    if (!selector) {
      throw new HttpError(400, "target.selector is required when using namespace+selector targeting");
    }
    target = { kind: "selector", namespace, selector };
  }

  return {
    timeWindow,
    target,
    include: {
      logs: { enabled: includeLogs, tailLines, previous, timestamps, excludePatterns },
      events: { enabled: includeEvents },
      metrics: { enabled: includeMetrics },
    },
    limits: {
      maxPods: effMaxPods,
      maxTotalLogLines: effMaxTotalLogLines,
      sinceSecondsMax: effSinceSecondsMax,
      maxMetricsPods: effMaxMetricsPods,
      metricsTimeoutMs: effMetricsTimeoutMs,
      metricsConcurrency: effMetricsConcurrency,
    },
  };
}
