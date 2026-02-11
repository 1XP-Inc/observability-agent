export type PodRef = {
  namespace: string;
  name: string;
  podIP?: string;
  annotations: Record<string, string>;
  labels: Record<string, string>;
  containers: string[];
};

export type LogFetchResult =
  | { ok: true; text: string }
  | { ok: false; skipped: true; reason: "no_previous_container" };

export type BundleRequest = {
  timeWindow?: {
    sinceSeconds?: number;
    start?: string; // ISO8601Z
    end?: string; // ISO8601Z
  };
  target?: {
    namespace?: string;
    selector?: string;
    pods?: Array<{ namespace: string; pod: string }>;
  };
  include?: {
    logs?: {
      enabled?: boolean;
      tailLines?: number;
      previous?: boolean;
      timestamps?: boolean;
      excludePatterns?: string[];
    };
    events?: { enabled?: boolean };
    metrics?: { enabled?: boolean };
  };
  limits?: {
    maxPods?: number;
    maxTotalLogLines?: number;
    sinceSecondsMax?: number;
    maxMetricsPods?: number;
    metricsTimeoutMs?: number;
    metricsConcurrency?: number;
    maxInflightBundles?: number;
  };
};

export type NormalizedBundleRequest = {
  timeWindow:
    | { kind: "relative"; sinceSeconds: number }
    | { kind: "absolute"; start: string; end: string };
  target:
    | { kind: "pods"; pods: Array<{ namespace: string; pod: string }> }
    | { kind: "selector"; namespace: string; selector: string };
  include: {
    logs: {
      enabled: boolean;
      tailLines: number;
      previous: boolean;
      timestamps: boolean;
      excludePatterns: string[];
    };
    events: { enabled: boolean };
    metrics: { enabled: boolean };
  };
  limits: {
    maxPods: number;
    maxTotalLogLines: number;
    sinceSecondsMax: number;
    maxMetricsPods: number;
    metricsTimeoutMs: number;
    metricsConcurrency: number;
  };
};

export type BundleStatus = "queued" | "running" | "done" | "failed";

export type BundleArtifact = {
  filename: string;
  contentType: "application/gzip";
  sizeBytes: number;
  expiresAt: string;
  downloadPath: string;
};

export type BundleJob<P = NormalizedBundleRequest> = {
  bundleId: string;
  status: BundleStatus;
  createdAt: string;
  updatedAt: string;
  expiresAt: string;
  params: P;
  artifactPath?: string;
  artifactSizeBytes?: number;
  error?: string;
};
