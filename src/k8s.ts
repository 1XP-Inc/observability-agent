import * as k8s from "@kubernetes/client-node";

export type K8sClients = {
  kc: k8s.KubeConfig;
  coreV1: k8s.CoreV1Api;
};

export function createK8sClients(): K8sClients {
  const kc = new k8s.KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) {
    kc.loadFromCluster();
  } else {
    // Local/dev fallback (uses ~/.kube/config).
    kc.loadFromDefault();
  }

  return {
    kc,
    coreV1: kc.makeApiClient(k8s.CoreV1Api),
  };
}

