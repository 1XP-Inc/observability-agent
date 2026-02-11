import { normalizeStandaloneBundleRequest } from "../../src/standalone/validate";
import { createMockConfig } from "../helpers";
import type { ServiceDef } from "../../src/standalone/types";

const services: ServiceDef[] = [
  { name: "solana-validator", logs: ["/var/log/solana/validator.log"], metrics: "http://localhost:9090/metrics" },
  { name: "rpc-node", logs: ["/var/log/solana/rpc.log"] },
];

function cfg(overrides?: any) {
  return createMockConfig({ mode: "standalone", services, ...overrides });
}

describe("normalizeStandaloneBundleRequest", () => {
  // --- body validation ---
  it("throws 400 for non-object body", () => {
    expect(() => normalizeStandaloneBundleRequest("string", cfg(), services)).toThrow("Body must be a JSON object");
  });

  it("throws 400 for array body", () => {
    expect(() => normalizeStandaloneBundleRequest([1, 2], cfg(), services)).toThrow("Body must be a JSON object");
  });

  it("throws 400 for null body", () => {
    expect(() => normalizeStandaloneBundleRequest(null, cfg(), services)).toThrow("Body must be a JSON object");
  });

  // --- target ---
  it("throws 400 when target is missing", () => {
    expect(() => normalizeStandaloneBundleRequest({}, cfg(), services)).toThrow("Missing required field: target");
  });

  it("throws 400 when target has no services", () => {
    expect(() => normalizeStandaloneBundleRequest({ target: { kind: "services" } }, cfg(), services)).toThrow("target.services must be a non-empty array");
  });

  it("throws 400 when target.services is empty array", () => {
    expect(() => normalizeStandaloneBundleRequest({ target: { kind: "services", services: [] } }, cfg(), services)).toThrow("target.services must be a non-empty array");
  });

  it("throws 400 for unknown service name", () => {
    expect(() => normalizeStandaloneBundleRequest(
      { target: { kind: "services", services: ["unknown-svc"] } },
      cfg(),
      services,
    )).toThrow("Unknown service: unknown-svc");
  });

  it("throws 400 for invalid target kind", () => {
    expect(() => normalizeStandaloneBundleRequest(
      { target: { kind: "pods" } },
      cfg(),
      services,
    )).toThrow("target.kind must be 'services'");
  });

  it("normalizes valid target with services", () => {
    const result = normalizeStandaloneBundleRequest(
      { target: { kind: "services", services: ["solana-validator"] } },
      cfg(),
      services,
    );
    expect(result.target).toEqual({ kind: "services", services: ["solana-validator"] });
  });

  it("infers kind='services' when services array is present", () => {
    const result = normalizeStandaloneBundleRequest(
      { target: { services: ["rpc-node"] } },
      cfg(),
      services,
    );
    expect(result.target).toEqual({ kind: "services", services: ["rpc-node"] });
  });

  // --- timeWindow ---
  it("defaults to relative time window with config defaults", () => {
    const result = normalizeStandaloneBundleRequest(
      { target: { kind: "services", services: ["solana-validator"] } },
      cfg(),
      services,
    );
    expect(result.timeWindow).toEqual({ kind: "relative", sinceSeconds: 600 });
  });

  it("uses sinceSeconds from request", () => {
    const result = normalizeStandaloneBundleRequest(
      { target: { kind: "services", services: ["solana-validator"] }, timeWindow: { sinceSeconds: 300 } },
      cfg(),
      services,
    );
    expect(result.timeWindow).toEqual({ kind: "relative", sinceSeconds: 300 });
  });

  it("supports absolute time window", () => {
    const result = normalizeStandaloneBundleRequest(
      {
        target: { kind: "services", services: ["solana-validator"] },
        timeWindow: { start: "2024-01-01T00:00:00Z", end: "2024-01-01T01:00:00Z" },
      },
      cfg(),
      services,
    );
    expect(result.timeWindow).toEqual({ kind: "absolute", start: "2024-01-01T00:00:00Z", end: "2024-01-01T01:00:00Z" });
  });

  it("throws 400 when sinceSeconds and start/end both provided", () => {
    expect(() => normalizeStandaloneBundleRequest(
      {
        target: { kind: "services", services: ["solana-validator"] },
        timeWindow: { sinceSeconds: 300, start: "2024-01-01T00:00:00Z", end: "2024-01-01T01:00:00Z" },
      },
      cfg(),
      services,
    )).toThrow("sinceSeconds together with start/end");
  });

  it("throws 400 when only start is provided", () => {
    expect(() => normalizeStandaloneBundleRequest(
      {
        target: { kind: "services", services: ["solana-validator"] },
        timeWindow: { start: "2024-01-01T00:00:00Z" },
      },
      cfg(),
      services,
    )).toThrow("timeWindow.start and timeWindow.end are required together");
  });

  it("throws 400 when end < start", () => {
    expect(() => normalizeStandaloneBundleRequest(
      {
        target: { kind: "services", services: ["solana-validator"] },
        timeWindow: { start: "2024-01-02T00:00:00Z", end: "2024-01-01T00:00:00Z" },
      },
      cfg(),
      services,
    )).toThrow("timeWindow.end must be >= timeWindow.start");
  });

  it("throws 400 when time range exceeds sinceSecondsMax", () => {
    expect(() => normalizeStandaloneBundleRequest(
      {
        target: { kind: "services", services: ["solana-validator"] },
        timeWindow: { start: "2024-01-01T00:00:00Z", end: "2024-01-10T00:00:00Z" },
      },
      cfg(),
      services,
    )).toThrow("sinceSecondsMax");
  });

  // --- include ---
  it("defaults include.logs.enabled to config default", () => {
    const result = normalizeStandaloneBundleRequest(
      { target: { kind: "services", services: ["solana-validator"] } },
      cfg(),
      services,
    );
    expect(result.include.logs.enabled).toBe(true);
  });

  it("defaults include.metrics.enabled to config default", () => {
    const result = normalizeStandaloneBundleRequest(
      { target: { kind: "services", services: ["solana-validator"] } },
      cfg(),
      services,
    );
    expect(result.include.metrics.enabled).toBe(true);
  });

  it("respects include.logs.enabled=false", () => {
    const result = normalizeStandaloneBundleRequest(
      {
        target: { kind: "services", services: ["solana-validator"] },
        include: { logs: { enabled: false } },
      },
      cfg(),
      services,
    );
    expect(result.include.logs.enabled).toBe(false);
  });

  it("throws 400 when excludePatterns too large", () => {
    const patterns = Array.from({ length: 51 }, (_, i) => `pat${i}`);
    expect(() => normalizeStandaloneBundleRequest(
      {
        target: { kind: "services", services: ["solana-validator"] },
        include: { logs: { excludePatterns: patterns } },
      },
      cfg(),
      services,
    )).toThrow("excludePatterns too large");
  });

  it("throws 400 when excludePatterns item too long", () => {
    expect(() => normalizeStandaloneBundleRequest(
      {
        target: { kind: "services", services: ["solana-validator"] },
        include: { logs: { excludePatterns: ["x".repeat(201)] } },
      },
      cfg(),
      services,
    )).toThrow("excludePatterns item too long");
  });

  // --- limits ---
  it("defaults limits from config", () => {
    const result = normalizeStandaloneBundleRequest(
      { target: { kind: "services", services: ["solana-validator"] } },
      cfg(),
      services,
    );
    expect(result.limits.maxTotalLogLines).toBe(50_000);
    expect(result.limits.sinceSecondsMax).toBe(3600);
    expect(result.limits.metricsTimeoutMs).toBe(2000);
  });

  it("throws 400 when limit exceeds hard max", () => {
    expect(() => normalizeStandaloneBundleRequest(
      {
        target: { kind: "services", services: ["solana-validator"] },
        limits: { maxTotalLogLines: 999_999 },
      },
      cfg(),
      services,
    )).toThrow("exceeds hard limit");
  });

  it("throws 400 for Infinity in limits", () => {
    expect(() => normalizeStandaloneBundleRequest(
      {
        target: { kind: "services", services: ["solana-validator"] },
        limits: { maxTotalLogLines: Infinity },
      },
      cfg(),
      services,
    )).toThrow("Invalid integer");
  });

  it("throws 400 for NaN in limits", () => {
    expect(() => normalizeStandaloneBundleRequest(
      {
        target: { kind: "services", services: ["solana-validator"] },
        limits: { maxTotalLogLines: NaN },
      },
      cfg(),
      services,
    )).toThrow("Invalid integer");
  });

  it("throws 400 for non-integer limits", () => {
    expect(() => normalizeStandaloneBundleRequest(
      {
        target: { kind: "services", services: ["solana-validator"] },
        limits: { sinceSecondsMax: "abc" },
      },
      cfg(),
      services,
    )).toThrow("Invalid integer");
  });

  // --- boolean validation ---
  it("throws 400 for invalid boolean value in include.logs.enabled", () => {
    expect(() => normalizeStandaloneBundleRequest(
      { target: { kind: "services", services: ["solana-validator"] }, include: { logs: { enabled: "invalid" } } },
      cfg(),
      services,
    )).toThrow("Invalid boolean");
  });

  it("accepts string 'true' and 'false' for boolean fields", () => {
    const result = normalizeStandaloneBundleRequest(
      { target: { kind: "services", services: ["solana-validator"] }, include: { logs: { enabled: "false" }, metrics: { enabled: "true" } } },
      cfg(),
      services,
    );
    expect(result.include.logs.enabled).toBe(false);
    expect(result.include.metrics.enabled).toBe(true);
  });

  // --- non-string exclude patterns ---
  it("throws 400 for non-string item in excludePatterns", () => {
    expect(() => normalizeStandaloneBundleRequest(
      { target: { kind: "services", services: ["solana-validator"] }, include: { logs: { excludePatterns: [123] } } },
      cfg(),
      services,
    )).toThrow("Invalid string");
  });

  it("throws 400 for non-array excludePatterns", () => {
    expect(() => normalizeStandaloneBundleRequest(
      { target: { kind: "services", services: ["solana-validator"] }, include: { logs: { excludePatterns: "not-array" } } },
      cfg(),
      services,
    )).toThrow("Invalid array");
  });

  // --- non-string services array ---
  it("throws 400 for non-string items in target.services", () => {
    expect(() => normalizeStandaloneBundleRequest(
      { target: { kind: "services", services: [123] } },
      cfg(),
      services,
    )).toThrow("Invalid string");
  });

  // --- ISO8601 edge cases ---
  it("throws 400 for non-UTC timestamp (no Z)", () => {
    expect(() => normalizeStandaloneBundleRequest(
      {
        target: { kind: "services", services: ["solana-validator"] },
        timeWindow: { start: "2024-01-01T00:00:00", end: "2024-01-02T00:00:00Z" },
      },
      cfg(),
      services,
    )).toThrow("must be ISO8601 UTC");
  });

  it("throws 400 for invalid datetime string", () => {
    expect(() => normalizeStandaloneBundleRequest(
      {
        target: { kind: "services", services: ["solana-validator"] },
        timeWindow: { start: "not-a-dateZ", end: "2024-01-02T00:00:00Z" },
      },
      cfg(),
      services,
    )).toThrow("Invalid datetime");
  });

  it("throws 400 for non-string in start", () => {
    expect(() => normalizeStandaloneBundleRequest(
      {
        target: { kind: "services", services: ["solana-validator"] },
        timeWindow: { start: 12345, end: "2024-01-02T00:00:00Z" },
      },
      cfg(),
      services,
    )).toThrow("Invalid string");
  });

  // --- clampLimit edge cases ---
  it("throws 400 when limit is below minimum", () => {
    expect(() => normalizeStandaloneBundleRequest(
      {
        target: { kind: "services", services: ["solana-validator"] },
        limits: { maxTotalLogLines: 0 },
      },
      cfg(),
      services,
    )).toThrow("must be >= 1");
  });

  it("throws 400 when sinceSeconds is below minimum", () => {
    expect(() => normalizeStandaloneBundleRequest(
      {
        target: { kind: "services", services: ["solana-validator"] },
        timeWindow: { sinceSeconds: 0 },
      },
      cfg(),
      services,
    )).toThrow("must be >= 1");
  });

  // --- full integration ---
  it("returns full normalized request with all defaults", () => {
    const result = normalizeStandaloneBundleRequest(
      {
        target: { kind: "services", services: ["solana-validator", "rpc-node"] },
        timeWindow: { sinceSeconds: 1800 },
        include: { logs: { enabled: true, excludePatterns: ["healthcheck"] }, metrics: { enabled: false } },
      },
      cfg(),
      services,
    );

    expect(result).toEqual({
      timeWindow: { kind: "relative", sinceSeconds: 1800 },
      target: { kind: "services", services: ["solana-validator", "rpc-node"] },
      include: {
        logs: { enabled: true, excludePatterns: ["healthcheck"] },
        metrics: { enabled: false },
      },
      limits: {
        maxTotalLogLines: 50_000,
        sinceSecondsMax: 3600,
        metricsTimeoutMs: 2000,
      },
    });
  });
});
