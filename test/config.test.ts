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
  // 기존 테스트는 K8s 모드 기반 — KUBERNETES_SERVICE_HOST 설정
  process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
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

  it("OA_JWT_SECRET 이 32자 미만이면 에러를 던진다", () => {
    process.env.OA_JWT_SECRET = "short-secret";
    expect(() => loadConfig()).toThrow("OA_JWT_SECRET must be at least 32 characters");
  });

  // --- 기본값 확인 ---
  it("OA_JWT_SECRET 만 설정하면 모든 기본값이 적용된다", () => {
    process.env.OA_JWT_SECRET = "my-secret-key-for-testing-hs256!";
    const cfg = loadConfig();

    expect(cfg.jwtSecret).toBe("my-secret-key-for-testing-hs256!");
    expect(cfg.host).toBe("0.0.0.0");
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
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_PORT = "3000";
    expect(loadConfig().port).toBe(3000);
  });

  it("OA_MAX_PODS 오버라이드", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_MAX_PODS = "50";
    expect(loadConfig().hardLimits.maxPods).toBe(50);
  });

  it("OA_MAX_TOTAL_LOG_LINES 오버라이드", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_MAX_TOTAL_LOG_LINES = "100000";
    expect(loadConfig().hardLimits.maxTotalLogLines).toBe(100_000);
  });

  it("OA_SINCE_SECONDS_MAX 오버라이드", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_SINCE_SECONDS_MAX = "7200";
    expect(loadConfig().hardLimits.sinceSecondsMax).toBe(7200);
  });

  it("OA_MAX_METRICS_PODS 오버라이드", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_MAX_METRICS_PODS = "100";
    expect(loadConfig().hardLimits.maxMetricsPods).toBe(100);
  });

  it("OA_METRICS_CONCURRENCY 오버라이드", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_METRICS_CONCURRENCY = "5";
    expect(loadConfig().hardLimits.metricsConcurrency).toBe(5);
  });

  it("OA_METRICS_TIMEOUT_MS 오버라이드", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_METRICS_TIMEOUT_MS = "5000";
    expect(loadConfig().hardLimits.metricsTimeoutMs).toBe(5000);
  });

  it("OA_BUNDLE_TTL_MINUTES 오버라이드 (분 → ms 변환)", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_BUNDLE_TTL_MINUTES = "30";
    expect(loadConfig().bundleTtlMs).toBe(30 * 60_000);
  });

  it("OA_CLEANUP_INTERVAL_MS 오버라이드", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_CLEANUP_INTERVAL_MS = "60000";
    expect(loadConfig().cleanupIntervalMs).toBe(60_000);
  });

  it("OA_MAX_INFLIGHT_BUNDLES 오버라이드", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_MAX_INFLIGHT_BUNDLES = "10";
    expect(loadConfig().maxInflightBundles).toBe(10);
  });

  it("OA_DEFAULT_SINCE_SECONDS 오버라이드", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_DEFAULT_SINCE_SECONDS = "300";
    expect(loadConfig().defaults.sinceSeconds).toBe(300);
  });

  it("OA_DEFAULT_TAIL_LINES 오버라이드", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_DEFAULT_TAIL_LINES = "500";
    expect(loadConfig().defaults.logs.tailLines).toBe(500);
  });

  // --- 문자열 환경변수 오버라이드 ---
  it("OA_BUNDLE_DIR 오버라이드", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_BUNDLE_DIR = "/custom/dir";
    expect(loadConfig().bundleDir).toBe("/custom/dir");
  });

  it("OA_JWT_ISS 오버라이드", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_JWT_ISS = "my-issuer";
    expect(loadConfig().jwtIss).toBe("my-issuer");
  });

  it("OA_JWT_AUD 오버라이드", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_JWT_AUD = "my-audience";
    expect(loadConfig().jwtAud).toBe("my-audience");
  });

  // --- boolean 환경변수 ---
  it("OA_DEFAULT_LOG_PREVIOUS=false 이면 false", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_DEFAULT_LOG_PREVIOUS = "false";
    expect(loadConfig().defaults.logs.previous).toBe(false);
  });

  it("OA_DEFAULT_LOG_PREVIOUS=true 이면 true", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_DEFAULT_LOG_PREVIOUS = "true";
    expect(loadConfig().defaults.logs.previous).toBe(true);
  });

  it("OA_DEFAULT_LOG_TIMESTAMPS=false 이면 false", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_DEFAULT_LOG_TIMESTAMPS = "false";
    expect(loadConfig().defaults.logs.timestamps).toBe(false);
  });

  it("OA_DEFAULT_INCLUDE_LOGS=false 이면 false", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_DEFAULT_INCLUDE_LOGS = "false";
    expect(loadConfig().defaults.include.logs).toBe(false);
  });

  it("OA_DEFAULT_INCLUDE_EVENTS=false 이면 false", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_DEFAULT_INCLUDE_EVENTS = "false";
    expect(loadConfig().defaults.include.events).toBe(false);
  });

  it("OA_DEFAULT_INCLUDE_METRICS=false 이면 false", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_DEFAULT_INCLUDE_METRICS = "false";
    expect(loadConfig().defaults.include.metrics).toBe(false);
  });

  // --- envInt: 숫자가 아닌 문자열 → fallback ---
  it("envInt 에 숫자가 아닌 값이 오면 기본값을 사용한다", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_PORT = "not-a-number";
    expect(loadConfig().port).toBe(8080);
  });

  it("envInt 에 빈 문자열이 오면 기본값을 사용한다", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_PORT = "";
    expect(loadConfig().port).toBe(8080);
  });

  it("envInt 에 공백만 있으면 기본값을 사용한다", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_PORT = "   ";
    expect(loadConfig().port).toBe(8080);
  });

  it("envInt 에 Infinity 가 오면 기본값을 사용한다", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_PORT = "Infinity";
    // parseInt("Infinity", 10) => NaN
    expect(loadConfig().port).toBe(8080);
  });

  // --- envString: 앞뒤 공백 제거 확인 ---
  it("OA_JWT_SECRET 의 앞뒤 공백이 제거된다", () => {
    process.env.OA_JWT_SECRET = "  my-secret-key-for-testing-hs256!  ";
    expect(loadConfig().jwtSecret).toBe("my-secret-key-for-testing-hs256!");
  });

  it("OA_BUNDLE_DIR 의 앞뒤 공백이 제거된다", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.OA_BUNDLE_DIR = "  /trimmed/path  ";
    expect(loadConfig().bundleDir).toBe("/trimmed/path");
  });

  // --- mode 감지 ---
  it("KUBERNETES_SERVICE_HOST 가 있으면 mode='k8s'", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
    expect(loadConfig().mode).toBe("k8s");
  });

  it("KUBERNETES_SERVICE_HOST 가 없으면 mode='standalone'", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[{"name":"svc1","logs":["/var/log/test.log"]}]';
    expect(loadConfig().mode).toBe("standalone");
  });

  // --- OA_SERVICES 파싱 ---
  it("standalone 모드에서 OA_SERVICES 미설정 시 에러", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    expect(() => loadConfig()).toThrow("OA_SERVICES is required in standalone mode");
  });

  it("OA_SERVICES 가 유효하지 않은 JSON이면 에러", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = "not-json";
    expect(() => loadConfig()).toThrow("OA_SERVICES is not valid JSON");
  });

  it("OA_SERVICES 가 배열이 아니면 에러", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '{"name":"svc"}';
    expect(() => loadConfig()).toThrow("OA_SERVICES must be a JSON array");
  });

  it("OA_SERVICES 항목이 객체가 아니면 에러", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '["not-object"]';
    expect(() => loadConfig()).toThrow("OA_SERVICES[0] must be an object");
  });

  it("OA_SERVICES 항목에 name 이 없으면 에러", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[{"logs":["/tmp/a.log"]}]';
    expect(() => loadConfig()).toThrow("OA_SERVICES[0].name is required");
  });

  it("OA_SERVICES 항목에 name 이 빈 문자열이면 에러", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[{"name":"  "}]';
    expect(() => loadConfig()).toThrow("OA_SERVICES[0].name is required");
  });

  it("OA_SERVICES 에 중복 name이 있으면 에러", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[{"name":"svc"},{"name":"svc"}]';
    expect(() => loadConfig()).toThrow("Duplicate service name: svc");
  });

  it("OA_SERVICES logs가 배열이 아니면 에러", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[{"name":"svc","logs":"/tmp/a.log"}]';
    expect(() => loadConfig()).toThrow("OA_SERVICES[0].logs must be an array");
  });

  it("OA_SERVICES logs 항목이 빈 문자열이면 에러", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[{"name":"svc","logs":[""]}]';
    expect(() => loadConfig()).toThrow("OA_SERVICES[0].logs[0] must be a non-empty string");
  });

  it("OA_SERVICES journal 정상 파싱", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[{"name":"svc","journal":"nginx.service"}]';
    const cfg = loadConfig();
    expect(cfg.services![0].journal).toBe("nginx.service");
    expect(cfg.services![0].journalScope).toBeUndefined();
  });

  it("OA_SERVICES user journal 정상 파싱", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[{"name":"svc","journal":"bera-beacond.service","journalScope":"user","journalUser":"ubuntu"}]';
    const cfg = loadConfig();
    expect(cfg.services![0]).toMatchObject({
      name: "svc",
      journal: "bera-beacond.service",
      journalScope: "user",
      journalUser: "ubuntu",
    });
  });

  it("OA_SERVICES journalUser 숫자 UID를 문자열로 파싱", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[{"name":"svc","journal":"app.service","journalScope":"user","journalUser":1000}]';
    const cfg = loadConfig();
    expect(cfg.services![0].journalUser).toBe("1000");
  });

  it("OA_SERVICES journalUser 숫자 UID가 음수면 에러", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[{"name":"svc","journal":"app.service","journalScope":"user","journalUser":-1}]';
    expect(() => loadConfig()).toThrow("OA_SERVICES[0].journalUser must be a non-empty string or integer UID");
  });

  it("OA_SERVICES journalUser 숫자 UID 범위 초과 시 에러", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[{"name":"svc","journal":"app.service","journalScope":"user","journalUser":4294967296}]';
    expect(() => loadConfig()).toThrow("OA_SERVICES[0].journalUser must be a non-empty string or integer UID");
  });

  it("OA_SERVICES journalScope 값이 잘못되면 에러", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[{"name":"svc","journal":"app.service","journalScope":"session"}]';
    expect(() => loadConfig()).toThrow('OA_SERVICES[0].journalScope must be "system" or "user"');
  });

  it("OA_SERVICES user journal에 journalUser가 없으면 에러", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[{"name":"svc","journal":"app.service","journalScope":"user"}]';
    expect(() => loadConfig()).toThrow("OA_SERVICES[0].journalUser is required when journalScope is user");
  });

  it("OA_SERVICES system journal에 journalUser가 있으면 에러", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[{"name":"svc","journal":"app.service","journalScope":"system","journalUser":"ubuntu"}]';
    expect(() => loadConfig()).toThrow("OA_SERVICES[0].journalUser requires journalScope to be user");
  });

  it("OA_SERVICES journal이 빈 문자열이면 에러", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[{"name":"svc","journal":"  "}]';
    expect(() => loadConfig()).toThrow("OA_SERVICES[0].journal must be a non-empty string");
  });

  it("OA_SERVICES journal이 숫자면 에러", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[{"name":"svc","journal":123}]';
    expect(() => loadConfig()).toThrow("OA_SERVICES[0].journal must be a non-empty string");
  });

  it("OA_SERVICES journal 미설정 시 undefined", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[{"name":"svc"}]';
    const cfg = loadConfig();
    expect(cfg.services![0].journal).toBeUndefined();
  });

  it("OA_SERVICES metrics가 빈 문자열이면 에러", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[{"name":"svc","metrics":"  "}]';
    expect(() => loadConfig()).toThrow("OA_SERVICES[0].metrics must be a non-empty string");
  });

  it("OA_SERVICES 정상 파싱", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = JSON.stringify([
      { name: "solana-validator", logs: ["/var/log/solana/validator.log"], metrics: "http://localhost:9090/metrics" },
      { name: "rpc-node", logs: ["/var/log/solana/rpc.log"] },
    ]);
    const cfg = loadConfig();
    expect(cfg.mode).toBe("standalone");
    expect(cfg.services).toHaveLength(2);
    expect(cfg.services![0]).toEqual({
      name: "solana-validator",
      logs: ["/var/log/solana/validator.log"],
      metrics: "http://localhost:9090/metrics",
    });
    expect(cfg.services![1]).toEqual({
      name: "rpc-node",
      logs: ["/var/log/solana/rpc.log"],
    });
  });

  it("K8s 모드에서 OA_SERVICES 설정하면 파싱된다", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
    process.env.OA_SERVICES = '[{"name":"svc"}]';
    const cfg = loadConfig();
    expect(cfg.mode).toBe("k8s");
    expect(cfg.services).toHaveLength(1);
  });

  it("K8s 모드에서 OA_SERVICES 없어도 에러 없음", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";
    const cfg = loadConfig();
    expect(cfg.mode).toBe("k8s");
    expect(cfg.services).toBeUndefined();
  });

  it("OA_SERVICES 항목이 배열이면 에러 (array, not object)", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[[1,2]]';
    expect(() => loadConfig()).toThrow("OA_SERVICES[0] must be an object");
  });

  it("OA_SERVICES 항목이 null이면 에러", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[null]';
    expect(() => loadConfig()).toThrow("OA_SERVICES[0] must be an object");
  });

  it("OA_SERVICES logs 항목이 숫자면 에러", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[{"name":"svc","logs":[123]}]';
    expect(() => loadConfig()).toThrow("OA_SERVICES[0].logs[0] must be a non-empty string");
  });

  it("OA_SERVICES metrics가 숫자면 에러", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[{"name":"svc","metrics":123}]';
    expect(() => loadConfig()).toThrow("OA_SERVICES[0].metrics must be a non-empty string");
  });

  it("OA_SERVICES name이 숫자면 에러", () => {
    process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
    delete process.env.KUBERNETES_SERVICE_HOST;
    process.env.OA_SERVICES = '[{"name":123}]';
    expect(() => loadConfig()).toThrow("OA_SERVICES[0].name is required");
  });

  // --- OA_ALLOWED_IPS 파싱 ---
  describe("OA_ALLOWED_IPS", () => {
    it("미설정 시 undefined", () => {
      process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
      expect(loadConfig().allowedIps).toBeUndefined();
    });

    it("빈 문자열이면 undefined", () => {
      process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
      process.env.OA_ALLOWED_IPS = "";
      expect(loadConfig().allowedIps).toBeUndefined();
    });

    it("단일 IP를 파싱한다", () => {
      process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
      process.env.OA_ALLOWED_IPS = "10.0.0.1";
      expect(loadConfig().allowedIps).toEqual(["10.0.0.1"]);
    });

    it("컴마 구분 리스트를 파싱한다", () => {
      process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
      process.env.OA_ALLOWED_IPS = "10.0.0.1,192.168.0.0/16,203.0.113.42";
      expect(loadConfig().allowedIps).toEqual(["10.0.0.1", "192.168.0.0/16", "203.0.113.42"]);
    });

    it("앞뒤 공백을 trim한다", () => {
      process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
      process.env.OA_ALLOWED_IPS = " 10.0.0.1 , 10.0.0.2 ";
      expect(loadConfig().allowedIps).toEqual(["10.0.0.1", "10.0.0.2"]);
    });

    it("빈 항목을 무시한다", () => {
      process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
      process.env.OA_ALLOWED_IPS = "10.0.0.1,,10.0.0.2,";
      expect(loadConfig().allowedIps).toEqual(["10.0.0.1", "10.0.0.2"]);
    });
  });

  // --- OA_TRUST_PROXY 파싱 ---
  describe("OA_TRUST_PROXY", () => {
    it("미설정 시 undefined", () => {
      process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
      expect(loadConfig().trustProxy).toBeUndefined();
    });

    it('"true" 이면 boolean true', () => {
      process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
      process.env.OA_TRUST_PROXY = "true";
      expect(loadConfig().trustProxy).toBe(true);
    });

    it("문자열 값은 그대로 전달한다", () => {
      process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
      process.env.OA_TRUST_PROXY = "127.0.0.1";
      expect(loadConfig().trustProxy).toBe("127.0.0.1");
    });

    it("CIDR 문자열도 그대로 전달한다", () => {
      process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
      process.env.OA_TRUST_PROXY = "10.0.0.0/8";
      expect(loadConfig().trustProxy).toBe("10.0.0.0/8");
    });

    it("빈 문자열이면 undefined", () => {
      process.env.OA_JWT_SECRET = "test-secret-key-for-config-tests!";
      process.env.OA_TRUST_PROXY = "";
      expect(loadConfig().trustProxy).toBeUndefined();
    });
  });
});
