import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

export async function tailLines(filePath: string, maxLines: number): Promise<string[]> {
  if (maxLines <= 0) return [];

  const buf: string[] = new Array(maxLines);
  let pos = 0;
  let count = 0;

  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf-8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    buf[pos] = line;
    pos = (pos + 1) % maxLines;
    count++;
  }

  if (count <= maxLines) return buf.slice(0, count);

  // Ring buffer unwrap: pos points to the oldest entry
  const result: string[] = new Array(maxLines);
  for (let i = 0; i < maxLines; i++) {
    result[i] = buf[(pos + i) % maxLines];
  }
  return result;
}
