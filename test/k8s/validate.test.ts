import { vi } from "vitest";
import { HttpError } from "../../src/http-error";
import { normalizeBundleRequest } from "../../src/k8s/validate";
import { createMockConfig } from "../helpers";
import type { OAConfig } from "../../src/config";

/* ------------------------------------------------------------------ */
/*  Helper: minimal valid selector-based request body                  */
/* ------------------------------------------------------------------ */
function minimalSelector(overrides?: Record<string, unknown>) {
  return {
    target: { namespace: "ns", selector: "app=web" },
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  HttpError                                                          */
/* ------------------------------------------------------------------ */
describe("HttpError", () => {
  it("creates with statusCode, message, and details", () => {
    const err = new HttpError(400, "bad", { field: "x" });
    expect(err).toBeInstanceOf(Error);
    expect(err.statusCode).toBe(400);
    expect(err.message).toBe("bad");
    expect(err.details).toEqual({ field: "x" });
    expect(err.name).toBe("HttpError");
  });

  it("details is optional", () => {
    const err = new HttpError(500, "oops");
    expect(err.details).toBeUndefined();
    expect(err.name).toBe("HttpError");
  });
});

/* ------------------------------------------------------------------ */
/*  normalizeBundleRequest                                             */
/* ------------------------------------------------------------------ */
describe("normalizeBundleRequest", () => {
  let config: OAConfig;
  beforeEach(() => {
    config = createMockConfig();
  });

  /* ---- Input validation ---- */
  describe("input validation", () => {
    it.each([null, undefined, "string", 42, [1, 2]])(
      "rejects non-object input: %p",
      (input) => {
        expect(() => normalizeBundleRequest(input, config)).toThrow(
          new HttpError(400, "Body must be a JSON object"),
        );
      },
    );

    it("rejects arrays specifically", () => {
      expect(() => normalizeBundleRequest([], config)).toThrow("Body must be a JSON object");
    });
  });

  /* ---- TimeWindow ---- */
  describe("timeWindow", () => {
    it("defaults to relative with config.defaults.sinceSeconds when no timeWindow", () => {
      const r = normalizeBundleRequest(minimalSelector(), config);
      expect(r.timeWindow).toEqual({ kind: "relative", sinceSeconds: 600 });
    });

    it("uses sinceSeconds for relative mode", () => {
      const r = normalizeBundleRequest(
        minimalSelector({ timeWindow: { sinceSeconds: 120 } }),
        config,
      );
      expect(r.timeWindow).toEqual({ kind: "relative", sinceSeconds: 120 });
    });

    it("uses string sinceSeconds via asInt", () => {
      const r = normalizeBundleRequest(
        minimalSelector({ timeWindow: { sinceSeconds: "300" } }),
        config,
      );
      expect(r.timeWindow).toEqual({ kind: "relative", sinceSeconds: 300 });
    });

    it("uses start+end for absolute mode", () => {
      const r = normalizeBundleRequest(
        minimalSelector({
          timeWindow: {
            start: "2024-01-01T00:00:00Z",
            end: "2024-01-01T00:05:00Z",
          },
        }),
        config,
      );
      expect(r.timeWindow).toEqual({
        kind: "absolute",
        start: "2024-01-01T00:00:00Z",
        end: "2024-01-01T00:05:00Z",
      });
    });

    it("rejects sinceSeconds + start/end together", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({
            timeWindow: {
              sinceSeconds: 60,
              start: "2024-01-01T00:00:00Z",
              end: "2024-01-01T00:01:00Z",
            },
          }),
          config,
        ),
      ).toThrow("cannot use sinceSeconds together with start/end");
    });

    it("rejects start without end", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ timeWindow: { start: "2024-01-01T00:00:00Z" } }),
          config,
        ),
      ).toThrow("timeWindow.start and timeWindow.end are required together");
    });

    it("rejects end without start", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ timeWindow: { end: "2024-01-01T00:00:00Z" } }),
          config,
        ),
      ).toThrow("timeWindow.start and timeWindow.end are required together");
    });

    it("rejects end < start", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({
            timeWindow: {
              start: "2024-01-01T01:00:00Z",
              end: "2024-01-01T00:00:00Z",
            },
          }),
          config,
        ),
      ).toThrow("timeWindow.end must be >= timeWindow.start");
    });

    it("rejects non-Z timestamps", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({
            timeWindow: {
              start: "2024-01-01T00:00:00+05:00",
              end: "2024-01-01T00:01:00Z",
            },
          }),
          config,
        ),
      ).toThrow("must be ISO8601 UTC (end with 'Z')");
    });

    it("rejects invalid datetime strings", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({
            timeWindow: {
              start: "not-a-dateZ",
              end: "2024-01-01T00:01:00Z",
            },
          }),
          config,
        ),
      ).toThrow("Invalid datetime: timeWindow.start");
    });

    it("rejects non-string datetime values", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({
            timeWindow: { start: 12345, end: "2024-01-01T00:01:00Z" },
          }),
          config,
        ),
      ).toThrow("Invalid string: timeWindow.start");
    });

    it("rejects window range exceeding sinceSecondsMax", () => {
      const cfg = createMockConfig();
      cfg.hardLimits.sinceSecondsMax = 60;
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({
            timeWindow: {
              start: "2024-01-01T00:00:00Z",
              end: "2024-01-01T01:00:00Z", // 3600s > 60s
            },
          }),
          cfg,
        ),
      ).toThrow("timeWindow range exceeds sinceSecondsMax");
    });

    it("rejects sinceSeconds exceeding sinceSecondsMax", () => {
      const cfg = createMockConfig();
      cfg.hardLimits.sinceSecondsMax = 60;
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ timeWindow: { sinceSeconds: 120 } }),
          cfg,
        ),
      ).toThrow("exceeds hard limit");
    });

    it("rejects sinceSeconds = 0 (min is 1)", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ timeWindow: { sinceSeconds: 0 } }),
          config,
        ),
      ).toThrow("must be >= 1");
    });

    it("forces timestamps=true in absolute mode", () => {
      const r = normalizeBundleRequest(
        {
          target: { namespace: "ns", selector: "app=web" },
          timeWindow: {
            start: "2024-01-01T00:00:00Z",
            end: "2024-01-01T00:05:00Z",
          },
          include: { logs: { timestamps: false } },
        },
        config,
      );
      expect(r.timeWindow.kind).toBe("absolute");
      expect(r.include.logs.timestamps).toBe(true);
    });

    it("allows timestamps=false in relative mode", () => {
      const r = normalizeBundleRequest(
        {
          target: { namespace: "ns", selector: "app=web" },
          include: { logs: { timestamps: false } },
        },
        config,
      );
      expect(r.timeWindow.kind).toBe("relative");
      expect(r.include.logs.timestamps).toBe(false);
    });

    it("rejects timeWindow that is not an object", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ timeWindow: "not-an-object" }),
          config,
        ),
      ).toThrow("Invalid object: timeWindow");
    });
  });

  /* ---- Target ---- */
  describe("target", () => {
    it("rejects missing target", () => {
      expect(() => normalizeBundleRequest({}, config)).toThrow(
        "Missing required field: target",
      );
    });

    it("rejects non-object target", () => {
      expect(() =>
        normalizeBundleRequest({ target: "bad" }, config),
      ).toThrow("Missing required field: target");
    });

    it("selector mode: namespace + selector", () => {
      const r = normalizeBundleRequest(
        { target: { namespace: "prod", selector: "app=api" } },
        config,
      );
      expect(r.target).toEqual({
        kind: "selector",
        namespace: "prod",
        selector: "app=api",
      });
    });

    it("namespace defaults to * in selector mode", () => {
      // When namespace is not provided but selector is, namespace defaults to *
      // We need to avoid triggering the "hasSelectorMode" path by not providing namespace at all.
      // But targetObj.namespace == null plus !!selector => hasSelectorMode = true
      // Actually, hasSelectorMode = !!selector || (targetObj.namespace != null)
      // So if just selector and no namespace provided, namespace defaults to "*"
      const r = normalizeBundleRequest(
        { target: { selector: "app=api" } },
        config,
      );
      expect(r.target).toEqual({
        kind: "selector",
        namespace: "*",
        selector: "app=api",
      });
    });

    it("pods mode: pods array", () => {
      const r = normalizeBundleRequest(
        {
          target: {
            pods: [{ namespace: "ns", pod: "pod-1" }],
          },
        },
        config,
      );
      expect(r.target).toEqual({
        kind: "pods",
        pods: [{ namespace: "ns", pod: "pod-1" }],
      });
    });

    it("rejects using both selector and pods", () => {
      expect(() =>
        normalizeBundleRequest(
          {
            target: {
              namespace: "ns",
              selector: "app=web",
              pods: [{ namespace: "ns", pod: "pod-1" }],
            },
          },
          config,
        ),
      ).toThrow("target must use either namespace+selector OR pods[] (not both)");
    });

    it("rejects pods with namespace set (both mode)", () => {
      expect(() =>
        normalizeBundleRequest(
          {
            target: {
              namespace: "ns",
              pods: [{ namespace: "ns", pod: "pod-1" }],
            },
          },
          config,
        ),
      ).toThrow("target must use either namespace+selector OR pods[] (not both)");
    });

    it("rejects pods with missing namespace", () => {
      expect(() =>
        normalizeBundleRequest(
          {
            target: {
              pods: [{ pod: "pod-1" }],
            },
          },
          config,
        ),
      ).toThrow("target.pods[0] requires namespace and pod");
    });

    it("rejects pods with missing pod name", () => {
      expect(() =>
        normalizeBundleRequest(
          {
            target: {
              pods: [{ namespace: "ns" }],
            },
          },
          config,
        ),
      ).toThrow("target.pods[0] requires namespace and pod");
    });

    it("rejects pod entry that is not an object", () => {
      expect(() =>
        normalizeBundleRequest(
          {
            target: {
              pods: ["not-an-object"],
            },
          },
          config,
        ),
      ).toThrow("target.pods[0] must be an object");
    });

    it("rejects pods exceeding maxPods", () => {
      const cfg = createMockConfig();
      cfg.hardLimits.maxPods = 2;
      const pods = Array.from({ length: 3 }, (_, i) => ({
        namespace: "ns",
        pod: `pod-${i}`,
      }));
      expect(() =>
        normalizeBundleRequest({ target: { pods } }, cfg),
      ).toThrow("target.pods exceeds maxPods (3 > 2)");
    });

    it("requires selector when no pods and just empty target", () => {
      // empty target object => no pods, no selector, but namespace is null
      // hasPods=false, hasSelectorMode = false || (null != null) = false
      // => goes to else branch, selector is undefined => throws
      expect(() =>
        normalizeBundleRequest({ target: {} }, config),
      ).toThrow("target.selector is required");
    });

    it("requires selector when namespace is not provided and pods is empty array", () => {
      // podsArr = [], podsArr.length = 0, so hasPods = false
      // hasSelectorMode = false (no selector, namespace == null) => else => throw
      expect(() =>
        normalizeBundleRequest({ target: { pods: [] } }, config),
      ).toThrow("target.selector is required");
    });

    it("trims namespace and selector strings", () => {
      const r = normalizeBundleRequest(
        { target: { namespace: "  ns  ", selector: "  app=web  " } },
        config,
      );
      expect(r.target).toEqual({
        kind: "selector",
        namespace: "ns",
        selector: "app=web",
      });
    });

    it("empty string namespace defaults to *", () => {
      const r = normalizeBundleRequest(
        { target: { namespace: "", selector: "app=web" } },
        config,
      );
      // namespace "" => trim => "" => undefined => "*"
      // but hasSelectorMode = !!selector || (targetObj.namespace != null)
      // targetObj.namespace = "" which is != null => hasSelectorMode = true
      expect(r.target).toEqual({
        kind: "selector",
        namespace: "*",
        selector: "app=web",
      });
    });

    it("whitespace-only namespace defaults to *", () => {
      const r = normalizeBundleRequest(
        { target: { namespace: "   ", selector: "app=web" } },
        config,
      );
      expect(r.target).toEqual({
        kind: "selector",
        namespace: "*",
        selector: "app=web",
      });
    });
  });

  /* ---- Include ---- */
  describe("include", () => {
    it("uses config defaults when include is omitted", () => {
      const r = normalizeBundleRequest(minimalSelector(), config);
      expect(r.include.logs.enabled).toBe(true);
      expect(r.include.events.enabled).toBe(true);
      expect(r.include.metrics.enabled).toBe(true);
      expect(r.include.logs.tailLines).toBe(2000);
      expect(r.include.logs.previous).toBe(true);
      expect(r.include.logs.timestamps).toBe(true);
      expect(r.include.logs.excludePatterns).toEqual([]);
    });

    it("overrides include.logs.enabled to false", () => {
      const r = normalizeBundleRequest(
        minimalSelector({ include: { logs: { enabled: false } } }),
        config,
      );
      expect(r.include.logs.enabled).toBe(false);
    });

    it("overrides include.events.enabled to false", () => {
      const r = normalizeBundleRequest(
        minimalSelector({ include: { events: { enabled: false } } }),
        config,
      );
      expect(r.include.events.enabled).toBe(false);
    });

    it("overrides include.metrics.enabled to false", () => {
      const r = normalizeBundleRequest(
        minimalSelector({ include: { metrics: { enabled: false } } }),
        config,
      );
      expect(r.include.metrics.enabled).toBe(false);
    });

    it("parses string boolean 'true' for include.logs.enabled", () => {
      const r = normalizeBundleRequest(
        minimalSelector({ include: { logs: { enabled: "true" } } }),
        config,
      );
      expect(r.include.logs.enabled).toBe(true);
    });

    it("parses string boolean 'false' for include.logs.enabled", () => {
      const r = normalizeBundleRequest(
        minimalSelector({ include: { logs: { enabled: "false" } } }),
        config,
      );
      expect(r.include.logs.enabled).toBe(false);
    });

    it("rejects non-boolean for include.logs.enabled", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ include: { logs: { enabled: 123 } } }),
          config,
        ),
      ).toThrow("Invalid boolean: include.logs.enabled");
    });

    it("rejects invalid string for include.logs.enabled", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ include: { logs: { enabled: "yes" } } }),
          config,
        ),
      ).toThrow("Invalid boolean: include.logs.enabled");
    });

    it("sets tailLines from request", () => {
      const r = normalizeBundleRequest(
        minimalSelector({ include: { logs: { tailLines: 500 } } }),
        config,
      );
      expect(r.include.logs.tailLines).toBe(500);
    });

    it("tailLines as string is accepted via asInt", () => {
      const r = normalizeBundleRequest(
        minimalSelector({ include: { logs: { tailLines: "100" } } }),
        config,
      );
      expect(r.include.logs.tailLines).toBe(100);
    });

    it("rejects non-integer tailLines", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ include: { logs: { tailLines: "abc" } } }),
          config,
        ),
      ).toThrow("Invalid integer: include.logs.tailLines");
    });

    it.each(["10junk", "1.9", 1.9])("rejects non-strict integer tailLines: %p", (tailLines) => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ include: { logs: { tailLines } } }),
          config,
        ),
      ).toThrow("Invalid integer: include.logs.tailLines");
    });

    it("rejects boolean tailLines", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ include: { logs: { tailLines: true } } }),
          config,
        ),
      ).toThrow("Invalid integer: include.logs.tailLines");
    });

    it("previous defaults from config", () => {
      const cfg = createMockConfig();
      cfg.defaults.logs.previous = false;
      const r = normalizeBundleRequest(minimalSelector(), cfg);
      expect(r.include.logs.previous).toBe(false);
    });

    it("overrides previous", () => {
      const r = normalizeBundleRequest(
        minimalSelector({ include: { logs: { previous: false } } }),
        config,
      );
      expect(r.include.logs.previous).toBe(false);
    });

    it("parses string previous", () => {
      const r = normalizeBundleRequest(
        minimalSelector({ include: { logs: { previous: "true" } } }),
        config,
      );
      expect(r.include.logs.previous).toBe(true);
    });

    it("timestamps default from config", () => {
      const cfg = createMockConfig();
      cfg.defaults.logs.timestamps = false;
      const r = normalizeBundleRequest(minimalSelector(), cfg);
      expect(r.include.logs.timestamps).toBe(false);
    });

    it("parses excludePatterns", () => {
      const r = normalizeBundleRequest(
        minimalSelector({
          include: { logs: { excludePatterns: ["foo", "bar"] } },
        }),
        config,
      );
      expect(r.include.logs.excludePatterns).toEqual(["foo", "bar"]);
    });

    it("trims and filters empty excludePatterns", () => {
      const r = normalizeBundleRequest(
        minimalSelector({
          include: { logs: { excludePatterns: ["  foo  ", "", "  "] } },
        }),
        config,
      );
      expect(r.include.logs.excludePatterns).toEqual(["foo"]);
    });

    it("rejects excludePatterns > 50 items", () => {
      const patterns = Array.from({ length: 51 }, (_, i) => `p${i}`);
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({
            include: { logs: { excludePatterns: patterns } },
          }),
          config,
        ),
      ).toThrow("include.logs.excludePatterns too large (max 50)");
    });

    it("rejects excludePatterns item > 200 chars", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({
            include: { logs: { excludePatterns: ["x".repeat(201)] } },
          }),
          config,
        ),
      ).toThrow("include.logs.excludePatterns item too long (max 200)");
    });

    it("rejects non-array excludePatterns", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({
            include: { logs: { excludePatterns: "not-array" } },
          }),
          config,
        ),
      ).toThrow("Invalid array: include.logs.excludePatterns");
    });

    it("rejects non-string item in excludePatterns", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({
            include: { logs: { excludePatterns: [123] } },
          }),
          config,
        ),
      ).toThrow("Invalid string: include.logs.excludePatterns[0]");
    });

    it("handles include that is not an object", () => {
      const r = normalizeBundleRequest(
        minimalSelector({ include: "not-object" }),
        config,
      );
      // should use all defaults
      expect(r.include.logs.enabled).toBe(true);
    });

    it("handles include.logs that is not an object", () => {
      const r = normalizeBundleRequest(
        minimalSelector({ include: { logs: "not-object" } }),
        config,
      );
      expect(r.include.logs.enabled).toBe(true);
    });

    it("handles include.events that is not an object", () => {
      const r = normalizeBundleRequest(
        minimalSelector({ include: { events: "not-object" } }),
        config,
      );
      expect(r.include.events.enabled).toBe(true);
    });

    it("handles include.metrics that is not an object", () => {
      const r = normalizeBundleRequest(
        minimalSelector({ include: { metrics: "not-object" } }),
        config,
      );
      expect(r.include.metrics.enabled).toBe(true);
    });
  });

  /* ---- Limits ---- */
  describe("limits", () => {
    it("uses config defaults when limits is omitted", () => {
      const r = normalizeBundleRequest(minimalSelector(), config);
      expect(r.limits).toEqual({
        maxPods: 20,
        maxTotalLogLines: 50_000,
        sinceSecondsMax: 3600,
        maxMetricsPods: 20,
        metricsTimeoutMs: 2000,
        metricsConcurrency: 10,
      });
    });

    it("overrides individual limits", () => {
      const r = normalizeBundleRequest(
        minimalSelector({
          include: { logs: { tailLines: 500 } },
          limits: {
            maxPods: 10,
            maxTotalLogLines: 1000,
            sinceSecondsMax: 600,
            maxMetricsPods: 5,
            metricsTimeoutMs: 500,
            metricsConcurrency: 3,
          },
        }),
        config,
      );
      expect(r.limits).toEqual({
        maxPods: 10,
        maxTotalLogLines: 1000,
        sinceSecondsMax: 600,
        maxMetricsPods: 5,
        metricsTimeoutMs: 500,
        metricsConcurrency: 3,
      });
    });

    it("string numeric limits are parsed via asInt", () => {
      const r = normalizeBundleRequest(
        minimalSelector({ limits: { maxPods: "15" } }),
        config,
      );
      expect(r.limits.maxPods).toBe(15);
    });

    it("rejects maxPods exceeding hardMax", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ limits: { maxPods: 999 } }),
          config,
        ),
      ).toThrow("exceeds hard limit");
    });

    it("rejects maxPods below min (1)", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ limits: { maxPods: 0 } }),
          config,
        ),
      ).toThrow("must be >= 1");
    });

    it("rejects maxTotalLogLines exceeding hardMax", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ limits: { maxTotalLogLines: 999_999 } }),
          config,
        ),
      ).toThrow("exceeds hard limit");
    });

    it("rejects sinceSecondsMax exceeding hardMax", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ limits: { sinceSecondsMax: 999_999 } }),
          config,
        ),
      ).toThrow("exceeds hard limit");
    });

    it("rejects metricsTimeoutMs exceeding hardMax", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ limits: { metricsTimeoutMs: 999_999 } }),
          config,
        ),
      ).toThrow("exceeds hard limit");
    });

    it("rejects metricsConcurrency exceeding hardMax", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ limits: { metricsConcurrency: 999 } }),
          config,
        ),
      ).toThrow("exceeds hard limit");
    });

    it("maxMetricsPods allows min of 0", () => {
      const r = normalizeBundleRequest(
        minimalSelector({ limits: { maxMetricsPods: 0 } }),
        config,
      );
      expect(r.limits.maxMetricsPods).toBe(0);
    });

    it("rejects non-integer limit values", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ limits: { maxPods: "abc" } }),
          config,
        ),
      ).toThrow("Invalid integer");
    });

    it("rejects empty-string limit values", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ limits: { maxPods: "" } }),
          config,
        ),
      ).toThrow("Invalid integer");
    });

    it("handles limits that is not an object (uses defaults)", () => {
      const r = normalizeBundleRequest(
        minimalSelector({ limits: "not-object" }),
        config,
      );
      expect(r.limits.maxPods).toBe(20);
    });

    it("rejects float numbers via asInt", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ limits: { maxPods: 5.9 } }),
          config,
        ),
      ).toThrow("Invalid integer: limits.maxPods");
    });

    it.each(["10junk", "1.9"])("rejects non-strict integer limit strings: %p", (maxPods) => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ limits: { maxPods } }),
          config,
        ),
      ).toThrow("Invalid integer: limits.maxPods");
    });

    it("rejects Infinity as asInt input", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ limits: { maxPods: Infinity } }),
          config,
        ),
      ).toThrow("Invalid integer");
    });

    it("rejects NaN as asInt input", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ limits: { maxPods: NaN } }),
          config,
        ),
      ).toThrow("Invalid integer");
    });

    it("rejects NaN from config defaults via clampLimit", () => {
      const cfg = createMockConfig();
      (cfg.hardLimits as any).maxPods = NaN;
      expect(() =>
        normalizeBundleRequest(minimalSelector(), cfg),
      ).toThrow("Invalid number");
    });
  });

  /* ---- Full round-trip ---- */
  describe("full round-trip", () => {
    it("produces complete NormalizedBundleRequest for selector target", () => {
      const r = normalizeBundleRequest(
        {
          target: { namespace: "production", selector: "app=api" },
          timeWindow: { sinceSeconds: 300 },
          include: {
            logs: {
              enabled: true,
              tailLines: 1000,
              previous: false,
              timestamps: false,
              excludePatterns: ["health"],
            },
            events: { enabled: false },
            metrics: { enabled: true },
          },
          limits: { maxPods: 10 },
        },
        config,
      );

      expect(r.timeWindow).toEqual({ kind: "relative", sinceSeconds: 300 });
      expect(r.target).toEqual({
        kind: "selector",
        namespace: "production",
        selector: "app=api",
      });
      expect(r.include.logs).toEqual({
        enabled: true,
        tailLines: 1000,
        previous: false,
        timestamps: false,
        excludePatterns: ["health"],
      });
      expect(r.include.events.enabled).toBe(false);
      expect(r.include.metrics.enabled).toBe(true);
      expect(r.limits.maxPods).toBe(10);
    });

    it("produces complete NormalizedBundleRequest for pods target", () => {
      const r = normalizeBundleRequest(
        {
          target: {
            pods: [
              { namespace: "ns1", pod: "pod-a" },
              { namespace: "ns2", pod: "pod-b" },
            ],
          },
        },
        config,
      );

      expect(r.target).toEqual({
        kind: "pods",
        pods: [
          { namespace: "ns1", pod: "pod-a" },
          { namespace: "ns2", pod: "pod-b" },
        ],
      });
    });
  });

  /* ---- Edge: tailLines clamped by maxTotalLogLines ---- */
  describe("tailLines clamped by maxTotalLogLines", () => {
    it("rejects tailLines exceeding maxTotalLogLines", () => {
      const cfg = createMockConfig();
      cfg.hardLimits.maxTotalLogLines = 100;
      cfg.defaults.logs.tailLines = 50;
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ include: { logs: { tailLines: 200 } } }),
          cfg,
        ),
      ).toThrow("exceeds hard limit");
    });

    it("tailLines 0 is accepted (min=0)", () => {
      const r = normalizeBundleRequest(
        minimalSelector({ include: { logs: { tailLines: 0 } } }),
        config,
      );
      expect(r.include.logs.tailLines).toBe(0);
    });
  });

  /* ---- asInt edge: whitespace-only string ---- */
  describe("asInt edge cases", () => {
    it("rejects whitespace-only string for sinceSeconds", () => {
      expect(() =>
        normalizeBundleRequest(
          minimalSelector({ timeWindow: { sinceSeconds: "   " } }),
          config,
        ),
      ).toThrow("Invalid integer");
    });
  });

  /* ---- nonEmptyString edge: non-string target.namespace ---- */
  describe("nonEmptyString edge cases", () => {
    it("rejects non-string namespace", () => {
      expect(() =>
        normalizeBundleRequest(
          { target: { namespace: 123, selector: "app=web" } },
          config,
        ),
      ).toThrow("Invalid string: target.namespace");
    });

    it("rejects non-string selector", () => {
      expect(() =>
        normalizeBundleRequest(
          { target: { selector: 123 } },
          config,
        ),
      ).toThrow("Invalid string: target.selector");
    });
  });
});
