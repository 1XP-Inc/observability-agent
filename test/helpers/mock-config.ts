import type { OAConfig } from "../../src/config";

/**
 * Creates a valid OAConfig for testing.
 * All values are reasonable defaults that can be overridden.
 */
export function createMockConfig(overrides?: Partial<OAConfig>): OAConfig {
  return {
    port: 8080,
    jwtSecret: "test-secret-key-for-testing",
    bundleDir: "/tmp/oa-test-bundles",
    bundleTtlMs: 60 * 60_000,
    cleanupIntervalMs: 120_000,
    maxInflightBundles: 5,
    hardLimits: {
      maxPods: 20,
      maxTotalLogLines: 50_000,
      sinceSecondsMax: 3600,
      maxMetricsPods: 20,
      metricsConcurrency: 10,
      metricsTimeoutMs: 2000,
    },
    defaults: {
      sinceSeconds: 600,
      logs: {
        tailLines: 2000,
        previous: true,
        timestamps: true,
      },
      include: {
        logs: true,
        events: true,
        metrics: true,
      },
    },
    ...overrides,
  };
}
