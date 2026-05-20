import fs from "node:fs/promises";
import path from "node:path";
import type { CoreV1Api } from "@kubernetes/client-node";
import type { OAConfig } from "../config";
import { createNdjsonGzipWriter } from "../bundle-writer";
import type { BundleJob } from "../types";
import type { NormalizedBundleRequest, PodRef } from "./types";
import { listPodsBySelector, readPodsByName } from "./pod-resolver";
import { collectLogs } from "./log-collector";
import { collectEvents } from "./event-collector";
import { collectMetrics } from "./metrics-collector";

export async function runBundle(params: {
  config: OAConfig;
  coreV1: CoreV1Api;
  job: BundleJob<NormalizedBundleRequest>;
}): Promise<void> {
  const { config, coreV1, job } = params;
  const req: NormalizedBundleRequest = job.params;

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

    const pods: PodRef[] =
      req.target.kind === "pods"
        ? await readPodsByName(coreV1, req.target.pods)
        : await listPodsBySelector(coreV1, req.target.namespace, req.target.selector, req.limits.maxPods);

    if (req.include.logs.enabled) {
      await collectLogs({ coreV1, writer, pods, req });
    }

    if (req.include.events.enabled) {
      const podUidByNameByNs: Map<string, Map<string, string | undefined>> = new Map();
      for (const p of pods) {
        if (!podUidByNameByNs.has(p.namespace)) podUidByNameByNs.set(p.namespace, new Map());
        podUidByNameByNs.get(p.namespace)!.set(p.name, p.uid);
      }

      const nowMs = Date.now();
      const eventsSinceTimeMs =
        req.timeWindow.kind === "relative"
          ? nowMs - req.timeWindow.sinceSeconds * 1000
          : Date.parse(req.timeWindow.start);

      await collectEvents({ coreV1, writer, podUidByNameByNs, req, eventsSinceTimeMs });
    }

    if (req.include.metrics.enabled) {
      await collectMetrics({ writer, pods, req });
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
