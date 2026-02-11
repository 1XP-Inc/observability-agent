import Fastify from "fastify";
import { loadConfig } from "./config";
import { authHook } from "./auth";
import { createK8sClients } from "./k8s";
import { createBundleManager } from "./bundle-manager";
import { registerRoutes } from "./routes";

async function main(): Promise<void> {
  const config = loadConfig();
  const { coreV1 } = createK8sClients();
  const bundles = createBundleManager(config, coreV1);
  bundles.startCleanupLoop();

  const app = Fastify({ logger: true, bodyLimit: 1_000_000 });

  app.get("/healthz", async () => ({ ok: true }));
  app.addHook("onRequest", authHook(config));
  registerRoutes(app, { config, coreV1, bundles });

  await app.listen({ host: "0.0.0.0", port: config.port });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
