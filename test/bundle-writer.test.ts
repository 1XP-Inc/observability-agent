import { vi } from "vitest";
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "oa-bundle-test-"));
  outPath = path.join(tmpDir, "test.ndjson.gz");
});

afterEach(() => {
  // 정리
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// gzip 파일을 읽어서 NDJSON 라인들을 파싱하는 헬퍼
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
  // 마지막 줄이 비어있을 수 있으므로 필터링
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

describe("createNdjsonGzipWriter", () => {
  it("단일 레코드를 쓰고 finalize 하면 유효한 gzip 파일이 생성된다", async () => {
    const writer = createNdjsonGzipWriter(outPath);
    await writer.writeRecord({ hello: "world" });
    await writer.finalize();

    expect(fs.existsSync(outPath)).toBe(true);
    const records = await readNdjsonGzip(outPath);
    expect(records).toEqual([{ hello: "world" }]);
  });

  it("여러 레코드를 쓰면 각 라인이 독립된 NDJSON 이다", async () => {
    const writer = createNdjsonGzipWriter(outPath);
    await writer.writeRecord({ id: 1, type: "log" });
    await writer.writeRecord({ id: 2, type: "event" });
    await writer.writeRecord({ id: 3, type: "metric" });
    await writer.finalize();

    const records = await readNdjsonGzip(outPath);
    expect(records).toHaveLength(3);
    expect(records[0]).toEqual({ id: 1, type: "log" });
    expect(records[1]).toEqual({ id: 2, type: "event" });
    expect(records[2]).toEqual({ id: 3, type: "metric" });
  });

  it("다양한 타입의 레코드를 처리한다", async () => {
    const writer = createNdjsonGzipWriter(outPath);
    await writer.writeRecord("string-record");
    await writer.writeRecord(42);
    await writer.writeRecord(null);
    await writer.writeRecord([1, 2, 3]);
    await writer.writeRecord({ nested: { deep: true } });
    await writer.finalize();

    const records = await readNdjsonGzip(outPath);
    expect(records).toHaveLength(5);
    expect(records[0]).toBe("string-record");
    expect(records[1]).toBe(42);
    expect(records[2]).toBeNull();
    expect(records[3]).toEqual([1, 2, 3]);
    expect(records[4]).toEqual({ nested: { deep: true } });
  });

  it("레코드 없이 finalize 만 해도 유효한 gzip 파일이 생성된다", async () => {
    const writer = createNdjsonGzipWriter(outPath);
    await writer.finalize();

    expect(fs.existsSync(outPath)).toBe(true);
    const records = await readNdjsonGzip(outPath);
    expect(records).toHaveLength(0);
  });

  it("대량의 레코드를 써서 backpressure (drain) 를 트리거한다", async () => {
    const writer = createNdjsonGzipWriter(outPath);

    // 충분히 많은 레코드를 작성하여 내부 버퍼를 채우고 drain 이벤트를 발생시킴
    const count = 10_000;
    for (let i = 0; i < count; i++) {
      await writer.writeRecord({
        index: i,
        data: "x".repeat(100), // 레코드 크기를 키워서 backpressure 유도
      });
    }
    await writer.finalize();

    const records = await readNdjsonGzip(outPath);
    expect(records).toHaveLength(count);
    // 첫 번째와 마지막 레코드 확인
    expect((records[0] as any).index).toBe(0);
    expect((records[count - 1] as any).index).toBe(count - 1);
  });

  it("동시에 여러 writeRecord 를 호출하여 backpressure 를 유도한다", async () => {
    const writer = createNdjsonGzipWriter(outPath);

    // await 없이 동시에 많은 write 를 걸어서 gzip 내부 버퍼를 채워
    // write() 가 false 를 반환하는 상황을 유도한다
    const count = 5_000;
    const bigPayload = "Y".repeat(1_000);
    const promises: Promise<void>[] = [];
    for (let i = 0; i < count; i++) {
      promises.push(writer.writeRecord({ i, d: bigPayload }));
    }
    await Promise.all(promises);
    await writer.finalize();

    const records = await readNdjsonGzip(outPath);
    expect(records).toHaveLength(count);
  });
});
