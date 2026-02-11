import { loadConfig } from "../src/config";

// 원래 process.env 를 보존
const originalEnv = process.env;

beforeEach(() => {
  // 매 테스트마다 깨끗한 환경변수로 시작
  process.env = { ...originalEnv };
  // 이전 테스트에서 설정된 OA_ 변수 제거
  for (const key of Object.keys(process.env)) {
    if (key.startsWith("OA_")) {
      delete process.env[key];
    }
  }
});

afterAll(() => {
  process.env = originalEnv;
});

describe("loadConfig", () => {
  // --- OA_JWT_SECRET 필수 ---
  it("OA_JWT_SECRET 이 없으면 에러를 던진다", () => {
    delete process.env.OA_JWT_SECRET;
    expect(() => loadConfig()).toThrow("Missing required env: OA_JWT_SECRET");
  });

  it("OA_JWT_SECRET 이 빈 문자열이면 에러를 던진다", () => {
    process.env.OA_JWT_SECRET = "";
    expect(() => loadConfig()).toThrow("Missing required env: OA_JWT_SECRET");
  });

  it("OA_JWT_SECRET 이 공백만 있으면 에러를 던진다", () => {
    process.env.OA_JWT_SECRET = "   ";
    expect(() => loadConfig()).toThrow("Missing required env: OA_JWT_SECRET");
  });

  // --- 기본값 확인 ---
  it("OA_JWT_SECRET 만 설정하면 모든 기본값이 적용된다", () => {
    process.env.OA_JWT_SECRET = "my-secret";
    const cfg = loadConfig();

    expect(cfg.jwtSecret).toBe("my-secret");
    expect(cfg.port).toBe(8080);
    expect(cfg.jwtIss).toBeUndefined();
    expect(cfg.jwtAud).toBeUndefined();
    expect(cfg.bundleDir).toBe("/tmp/oa-bundles");
    expect(cfg.bundleTtlMs).toBe(60 * 60_000); // 60분
    expect(cfg.cleanupIntervalMs).toBe(120_000);
    expect(cfg.maxInflightBundles).toBe(5);

    // hardLimits 기본값
    expect(cfg.hardLimits).toEqual({
      maxPods: 20,
      maxTotalLogLines: 50_000,
      sinceSecondsMax: 3600,
      maxMetricsPods: 20,
      metricsConcurrency: 10,
      metricsTimeoutMs: 2000,
    });

    // defaults 기본값
    expect(cfg.defaults.sinceSeconds).toBe(600);
    expect(cfg.defaults.logs).toEqual({
      tailLines: 2000,
      previous: true,
      timestamps: true,
    });
    expect(cfg.defaults.include).toEqual({
      logs: true,
      events: true,
      metrics: true,
    });
  });

  // --- 정수 환경변수 오버라이드 ---
  it("OA_PORT 오버라이드", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_PORT = "3000";
    expect(loadConfig().port).toBe(3000);
  });

  it("OA_MAX_PODS 오버라이드", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_MAX_PODS = "50";
    expect(loadConfig().hardLimits.maxPods).toBe(50);
  });

  it("OA_MAX_TOTAL_LOG_LINES 오버라이드", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_MAX_TOTAL_LOG_LINES = "100000";
    expect(loadConfig().hardLimits.maxTotalLogLines).toBe(100_000);
  });

  it("OA_SINCE_SECONDS_MAX 오버라이드", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_SINCE_SECONDS_MAX = "7200";
    expect(loadConfig().hardLimits.sinceSecondsMax).toBe(7200);
  });

  it("OA_MAX_METRICS_PODS 오버라이드", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_MAX_METRICS_PODS = "100";
    expect(loadConfig().hardLimits.maxMetricsPods).toBe(100);
  });

  it("OA_METRICS_CONCURRENCY 오버라이드", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_METRICS_CONCURRENCY = "5";
    expect(loadConfig().hardLimits.metricsConcurrency).toBe(5);
  });

  it("OA_METRICS_TIMEOUT_MS 오버라이드", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_METRICS_TIMEOUT_MS = "5000";
    expect(loadConfig().hardLimits.metricsTimeoutMs).toBe(5000);
  });

  it("OA_BUNDLE_TTL_MINUTES 오버라이드 (분 → ms 변환)", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_BUNDLE_TTL_MINUTES = "30";
    expect(loadConfig().bundleTtlMs).toBe(30 * 60_000);
  });

  it("OA_CLEANUP_INTERVAL_MS 오버라이드", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_CLEANUP_INTERVAL_MS = "60000";
    expect(loadConfig().cleanupIntervalMs).toBe(60_000);
  });

  it("OA_MAX_INFLIGHT_BUNDLES 오버라이드", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_MAX_INFLIGHT_BUNDLES = "10";
    expect(loadConfig().maxInflightBundles).toBe(10);
  });

  it("OA_DEFAULT_SINCE_SECONDS 오버라이드", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_DEFAULT_SINCE_SECONDS = "300";
    expect(loadConfig().defaults.sinceSeconds).toBe(300);
  });

  it("OA_DEFAULT_TAIL_LINES 오버라이드", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_DEFAULT_TAIL_LINES = "500";
    expect(loadConfig().defaults.logs.tailLines).toBe(500);
  });

  // --- 문자열 환경변수 오버라이드 ---
  it("OA_BUNDLE_DIR 오버라이드", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_BUNDLE_DIR = "/custom/dir";
    expect(loadConfig().bundleDir).toBe("/custom/dir");
  });

  it("OA_JWT_ISS 오버라이드", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_JWT_ISS = "my-issuer";
    expect(loadConfig().jwtIss).toBe("my-issuer");
  });

  it("OA_JWT_AUD 오버라이드", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_JWT_AUD = "my-audience";
    expect(loadConfig().jwtAud).toBe("my-audience");
  });

  // --- boolean 환경변수 ---
  it("OA_DEFAULT_LOG_PREVIOUS=false 이면 false", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_DEFAULT_LOG_PREVIOUS = "false";
    expect(loadConfig().defaults.logs.previous).toBe(false);
  });

  it("OA_DEFAULT_LOG_PREVIOUS=true 이면 true", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_DEFAULT_LOG_PREVIOUS = "true";
    expect(loadConfig().defaults.logs.previous).toBe(true);
  });

  it("OA_DEFAULT_LOG_TIMESTAMPS=false 이면 false", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_DEFAULT_LOG_TIMESTAMPS = "false";
    expect(loadConfig().defaults.logs.timestamps).toBe(false);
  });

  it("OA_DEFAULT_INCLUDE_LOGS=false 이면 false", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_DEFAULT_INCLUDE_LOGS = "false";
    expect(loadConfig().defaults.include.logs).toBe(false);
  });

  it("OA_DEFAULT_INCLUDE_EVENTS=false 이면 false", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_DEFAULT_INCLUDE_EVENTS = "false";
    expect(loadConfig().defaults.include.events).toBe(false);
  });

  it("OA_DEFAULT_INCLUDE_METRICS=false 이면 false", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_DEFAULT_INCLUDE_METRICS = "false";
    expect(loadConfig().defaults.include.metrics).toBe(false);
  });

  // --- envInt: 숫자가 아닌 문자열 → fallback ---
  it("envInt 에 숫자가 아닌 값이 오면 기본값을 사용한다", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_PORT = "not-a-number";
    expect(loadConfig().port).toBe(8080);
  });

  it("envInt 에 빈 문자열이 오면 기본값을 사용한다", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_PORT = "";
    expect(loadConfig().port).toBe(8080);
  });

  it("envInt 에 공백만 있으면 기본값을 사용한다", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_PORT = "   ";
    expect(loadConfig().port).toBe(8080);
  });

  it("envInt 에 Infinity 가 오면 기본값을 사용한다", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_PORT = "Infinity";
    // parseInt("Infinity", 10) => NaN
    expect(loadConfig().port).toBe(8080);
  });

  // --- envString: 앞뒤 공백 제거 확인 ---
  it("OA_JWT_SECRET 의 앞뒤 공백이 제거된다", () => {
    process.env.OA_JWT_SECRET = "  my-secret  ";
    expect(loadConfig().jwtSecret).toBe("my-secret");
  });

  it("OA_BUNDLE_DIR 의 앞뒤 공백이 제거된다", () => {
    process.env.OA_JWT_SECRET = "s";
    process.env.OA_BUNDLE_DIR = "  /trimmed/path  ";
    expect(loadConfig().bundleDir).toBe("/trimmed/path");
  });
});
