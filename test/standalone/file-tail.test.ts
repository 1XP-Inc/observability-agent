import { vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tailLines } from "../../src/standalone/file-tail";

function tmpFile(content: string): string {
  const p = path.join(os.tmpdir(), `file-tail-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

afterEach(() => {
  // Clean up temp files created by tests
});

describe("tailLines", () => {
  it("returns all lines when file has fewer lines than maxLines", async () => {
    const f = tmpFile("line1\nline2\nline3\n");
    const result = await tailLines(f, 10);
    expect(result).toEqual(["line1", "line2", "line3"]);
    fs.unlinkSync(f);
  });

  it("returns last N lines when file has more lines than maxLines", async () => {
    const f = tmpFile("a\nb\nc\nd\ne\n");
    const result = await tailLines(f, 3);
    expect(result).toEqual(["c", "d", "e"]);
    fs.unlinkSync(f);
  });

  it("returns exact number when file has exactly maxLines lines", async () => {
    const f = tmpFile("x\ny\nz\n");
    const result = await tailLines(f, 3);
    expect(result).toEqual(["x", "y", "z"]);
    fs.unlinkSync(f);
  });

  it("returns empty array for empty file", async () => {
    const f = tmpFile("");
    const result = await tailLines(f, 10);
    expect(result).toEqual([]);
    fs.unlinkSync(f);
  });

  it("returns empty array when maxLines is 0", async () => {
    const f = tmpFile("line1\nline2\n");
    const result = await tailLines(f, 0);
    expect(result).toEqual([]);
    fs.unlinkSync(f);
  });

  it("handles single line file", async () => {
    const f = tmpFile("single line\n");
    const result = await tailLines(f, 5);
    expect(result).toEqual(["single line"]);
    fs.unlinkSync(f);
  });

  it("handles file without trailing newline", async () => {
    const f = tmpFile("a\nb\nc");
    const result = await tailLines(f, 2);
    expect(result).toEqual(["b", "c"]);
    fs.unlinkSync(f);
  });

  it("handles maxLines = 1", async () => {
    const f = tmpFile("a\nb\nc\n");
    const result = await tailLines(f, 1);
    expect(result).toEqual(["c"]);
    fs.unlinkSync(f);
  });

  it("throws for non-existent file", async () => {
    await expect(tailLines("/tmp/nonexistent-file-12345.log", 10)).rejects.toThrow();
  });

  it("handles large number of lines efficiently", async () => {
    const lines = Array.from({ length: 10000 }, (_, i) => `line-${i}`);
    const f = tmpFile(lines.join("\n") + "\n");
    const result = await tailLines(f, 5);
    expect(result).toEqual(["line-9995", "line-9996", "line-9997", "line-9998", "line-9999"]);
    fs.unlinkSync(f);
  });

  it("preserves line content including spaces and special chars", async () => {
    const f = tmpFile("2024-01-01T00:00:00Z [INFO] hello world\n  indented line  \n");
    const result = await tailLines(f, 10);
    expect(result).toEqual([
      "2024-01-01T00:00:00Z [INFO] hello world",
      "  indented line  ",
    ]);
    fs.unlinkSync(f);
  });
});
