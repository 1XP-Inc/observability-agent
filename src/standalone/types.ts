export type JournalScope = "system" | "user";

export type ServiceDef = {
  name: string;
  logs?: string[];
  journal?: string;
  journalScope?: JournalScope;
  journalUser?: string;
  metrics?: string;
};

export type StandaloneTarget =
  | { kind: "services"; services: string[] }
  | { kind: "all" };

export type StandaloneNormalizedRequest = {
  timeWindow?:
    | { kind: "relative"; sinceSeconds: number }
    | { kind: "absolute"; start: string; end: string };
  target: StandaloneTarget;
  include: {
    logs: {
      enabled: boolean;
      tailLines: number;
      includePatterns: string[];
      excludePatterns: string[];
    };
    metrics: { enabled: boolean };
  };
  limits: {
    maxTotalLogLines: number;
    sinceSecondsMax: number;
    metricsTimeoutMs: number;
  };
};
