import { vi } from "vitest";

const mockLoadFromCluster = vi.fn();
const mockLoadFromDefault = vi.fn();
const mockMakeApiClient = vi.fn().mockReturnValue({ fake: "coreV1" });

vi.mock("@kubernetes/client-node", () => {
  // vi.mock factory 내에서 class 키워드 사용 필수 (vitest 호이스팅 요구)
  const loadFromCluster = vi.fn();
  const loadFromDefault = vi.fn();
  const makeApiClient = vi.fn().mockReturnValue({ fake: "coreV1" });

  class MockKubeConfig {
    loadFromCluster = loadFromCluster;
    loadFromDefault = loadFromDefault;
    makeApiClient = makeApiClient;
  }

  return {
    KubeConfig: MockKubeConfig,
    CoreV1Api: class CoreV1Api {},
    __mocks: { loadFromCluster, loadFromDefault, makeApiClient },
  };
});

import { createK8sClients } from "../src/k8s";
import * as k8sMod from "@kubernetes/client-node";

// factory 내부 mock 참조 가져오기
const mocks = (k8sMod as any).__mocks as {
  loadFromCluster: ReturnType<typeof vi.fn>;
  loadFromDefault: ReturnType<typeof vi.fn>;
  makeApiClient: ReturnType<typeof vi.fn>;
};

const originalEnv = process.env;

beforeEach(() => {
  process.env = { ...originalEnv };
  mocks.loadFromCluster.mockClear();
  mocks.loadFromDefault.mockClear();
  mocks.makeApiClient.mockClear();
});

afterAll(() => {
  process.env = originalEnv;
});

describe("createK8sClients", () => {
  it("KUBERNETES_SERVICE_HOST 가 설정되어 있으면 loadFromCluster 를 호출한다", () => {
    process.env.KUBERNETES_SERVICE_HOST = "10.0.0.1";

    const result = createK8sClients();

    expect(mocks.loadFromCluster).toHaveBeenCalledOnce();
    expect(mocks.loadFromDefault).not.toHaveBeenCalled();
    expect(mocks.makeApiClient).toHaveBeenCalledOnce();
    expect(result.coreV1).toEqual({ fake: "coreV1" });
    expect(result.kc).toBeDefined();
  });

  it("KUBERNETES_SERVICE_HOST 가 없으면 loadFromDefault 를 호출한다", () => {
    delete process.env.KUBERNETES_SERVICE_HOST;

    const result = createK8sClients();

    expect(mocks.loadFromDefault).toHaveBeenCalledOnce();
    expect(mocks.loadFromCluster).not.toHaveBeenCalled();
    expect(mocks.makeApiClient).toHaveBeenCalledOnce();
    expect(result.coreV1).toEqual({ fake: "coreV1" });
    expect(result.kc).toBeDefined();
  });
});
