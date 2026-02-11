import Fastify from "fastify";
import { loadConfig } from "./config";
import { authHook } from "./auth";
import { createBundleManager } from "./bundle-manager";
import type { BundleJob, NormalizedBundleRequest } from "./types";
import type { StandaloneNormalizedRequest } from "./standalone/types";

async function main(): Promise<void> {
  const config = loadConfig();

  const app = Fastify({
    logger: true,
    bodyLimit: 1_000_000,
    trustProxy: config.trustProxy,
  });

  app.get("/healthz", async () => ({ ok: true }));

  if (config.allowedIps) {
    const { parseAllowList, ipFilterHook } = await import("./ip-filter");
    app.addHook("onRequest", ipFilterHook(parseAllowList(config.allowedIps)));
  }

  app.addHook("onRequest", authHook(config));

  if (config.mode === "k8s") {
    const { createK8sClients } = await import("./k8s");
    const { runBundle } = await import("./bundle-runner");
    const { registerRoutes } = await import("./routes");

    const { coreV1 } = createK8sClients();
    const runFn = (job: BundleJob<NormalizedBundleRequest>) => runBundle({ config, coreV1, job });
    const bundles = createBundleManager(config, runFn);
    bundles.startCleanupLoop();

    registerRoutes(app, { config, coreV1, bundles });
  } else {
    const { runStandaloneBundle } = await import("./standalone/bundle-runner");
    const { registerStandaloneRoutes } = await import("./standalone/routes");

    const services = config.services!;
    const runFn = (job: BundleJob<StandaloneNormalizedRequest>) =>
      runStandaloneBundle({ config, services, job });
    const bundles = createBundleManager(config, runFn);
    bundles.startCleanupLoop();

    registerStandaloneRoutes(app, { config, services, bundles });
  }

  await app.listen({ host: "0.0.0.0", port: config.port });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
