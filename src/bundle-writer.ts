import fs from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

export type NdjsonGzipWriter = {
  writeRecord: (record: unknown) => Promise<void>;
  finalize: () => Promise<void>;
  destroy: () => void;
};

export function createNdjsonGzipWriter(outPath: string): NdjsonGzipWriter {
  const gzip = createGzip();
  const out = fs.createWriteStream(outPath);
  const pipePromise = pipeline(gzip, out);
  let queue: Promise<void> = Promise.resolve();

  async function writeChunk(chunk: string): Promise<void> {
    if (!gzip.write(chunk)) {
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          gzip.off("drain", onDrain);
          reject(err);
        };
        const onDrain = () => {
          gzip.off("error", onError);
          resolve();
        };
        gzip.once("error", onError);
        gzip.once("drain", onDrain);
      });
    }
  }

  return {
    async writeRecord(record: unknown) {
      const line = `${JSON.stringify(record)}\n`;
      const next = queue.then(() => writeChunk(line));
      queue = next.catch(() => {});
      return next;
    },
    async finalize() {
      await queue.catch(() => {});
      gzip.end();
      await pipePromise;
    },
    destroy() {
      gzip.destroy();
      out.destroy();
      pipePromise.catch(() => {});
    },
  };
}

