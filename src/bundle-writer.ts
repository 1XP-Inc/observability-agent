import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

export type NdjsonGzipWriter = {
  writeRecord: (record: unknown) => Promise<void>;
  finalize: () => Promise<void>;
};

export function createNdjsonGzipWriter(outPath: string): NdjsonGzipWriter {
  const gzip = createGzip();
  const out = fs.createWriteStream(outPath);
  const pipePromise = pipeline(gzip, out);

  async function writeChunk(chunk: string): Promise<void> {
    if (!gzip.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => reject(err);
        gzip.once("error", onError);
        gzip.once("drain", () => {
          gzip.off("error", onError);
          resolve();
        });
      });
    }
  }

  return {
    async writeRecord(record: unknown) {
      const line = `${JSON.stringify(record)}\n`;
      await writeChunk(line);
    },
    async finalize() {
      gzip.end();
      await pipePromise;
    },
  };
}

