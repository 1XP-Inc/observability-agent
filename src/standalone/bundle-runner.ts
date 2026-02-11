import fs from "node:fs/promises";
import path from "node:path";
import type { OAConfig } from "../config";
import { createNdjsonGzipWriter } from "../bundle-writer";
import type { BundleJob } from "../types";
import type { ServiceDef, StandaloneNormalizedRequest } from "./types";
import { collectStandaloneLogs } from "./log-collector";
import { collectStandaloneMetrics } from "./metrics-collector";

export async function runStandaloneBundle(params: {
  config: OAConfig;
  services: ServiceDef[];
  job: BundleJob<StandaloneNormalizedRequest>;
}): Promise<void> {
  const { config, services, job } = params;
  const req = job.params;

  await fs.mkdir(config.bundleDir, { recursive: true, mode: 0o700 });
  const artifactPath = path.join(config.bundleDir, `${job.bundleId}.ndjson.gz`);

  const writer = createNdjsonGzipWriter(artifactPath);
  try {
    await writer.writeRecord({
      type: "meta",
      bundleId: job.bundleId,
      createdAt: job.createdAt,
      params: req,
    });

    // Resolve target services
    const targetServices: ServiceDef[] =
      req.target.kind === "all"
        ? services
        : services.filter((s) => (req.target as { services: string[] }).services.includes(s.name));

    if (req.include.logs.enabled) {
      await collectStandaloneLogs({ writer, services: targetServices, req });
    }

    if (req.include.metrics.enabled) {
      await collectStandaloneMetrics({ writer, services: targetServices, req });
    }

    await writer.finalize();
  } catch (err) {
    writer.destroy();
    throw err;
  }

  job.artifactPath = artifactPath;
  const st = await fs.stat(artifactPath);
  job.artifactSizeBytes = st.size;
}
