import { vi } from "vitest";

// writeChunk 의 drain 대기 및 error 경로를 커버하기 위해 node:zlib mock
// createGzip 반환값의 write 를 래핑하여 false 반환 + 비동기 drain/error emit
let forceBackpressure = false;
let forceErrorOnDrain = false;
let lastGzipStream: ReturnType<typeof import("node:zlib").createGzip> | undefined;

vi.mock("node:zlib", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:zlib")>();
  return {
    ...actual,
    createGzip: (...args: any[]) => {
      const gzipStream = (actual.createGzip as any)(...args);
      lastGzipStream = gzipStream;
      const originalWrite = gzipStream.write.bind(gzipStream);

      gzipStream.write = function (chunk: any, ...rest: any[]) {
        const result = originalWrite(chunk, ...rest);
        if (forceBackpressure) {
          if (forceErrorOnDrain) {
            // drain 대기 중에 error 를 emit 하여 onError reject 경로를 커버
            process.nextTick(() => gzipStream.emit("error", new Error("forced gzip error")));
          } else {
            process.nextTick(() => gzipStream.emit("drain"));
          }
          return false;
        }
        return result;
      };
      return gzipStream;
    },
  };
});

import fs from "node:fs";
import { createGunzip } from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Writable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { createNdjsonGzipWriter } from "../src/bundle-writer";

let tmpDir: string;
let outPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-drain-test-"));
  outPath = path.join(tmpDir, "drain.ndjson.gz");
  forceBackpressure = false;
  forceErrorOnDrain = false;
  lastGzipStream = undefined;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function readNdjsonGzip(filePath: string): Promise<unknown[]> {
  const chunks: Buffer[] = [];
  const gunzip = createGunzip();
  const readStream = fs.createReadStream(filePath);
  const collector = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk);
      callback();
    },
  });
  await pipeline(readStream, gunzip, collector);
  const text = Buffer.concat(chunks).toString("utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

describe("createNdjsonGzipWriter drain 경로", () => {
  it("gzip.write 가 false 를 반환하면 drain 이벤트를 대기한 후 정상 완료한다", async () => {
    forceBackpressure = true;

    const writer = createNdjsonGzipWriter(outPath);
    // 첫 번째 레코드: write -> false 반환 -> drain 대기 -> nextTick drain emit -> resolve
    await writer.writeRecord({ drain: "test1" });

    // backpressure 해제 후 추가 레코드
    forceBackpressure = false;
    await writer.writeRecord({ drain: "test2" });
    await writer.finalize();

    const records = await readNdjsonGzip(outPath);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({ drain: "test1" });
    expect(records[1]).toEqual({ drain: "test2" });
  });

  it("drain 대기 중 gzip error 가 발생하면 writeRecord 가 reject 된다", async () => {
    forceBackpressure = true;
    forceErrorOnDrain = true;

    const writer = createNdjsonGzipWriter(outPath);
    // write -> false 반환 -> onError 콜백 호출 -> reject
    await expect(writer.writeRecord({ error: "test" })).rejects.toThrow("forced gzip error");
    expect(lastGzipStream).toBeDefined();
    expect(lastGzipStream!.listenerCount("drain")).toBe(0);

    // pipeline 프로미스도 rejected 되므로 finalize 에서 에러를 잡아준다
    // (unhandled rejection 방지)
    await writer.finalize().catch(() => {});
  });
});
