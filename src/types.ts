export type BundleStatus = "queued" | "running" | "done" | "failed";

export type BundleArtifact = {
  filename: string;
  contentType: "application/gzip";
  sizeBytes: number;
  expiresAt: string;
  downloadPath: string;
};

export type BundleJob<P> = {
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
