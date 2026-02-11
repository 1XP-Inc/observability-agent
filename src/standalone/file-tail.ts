import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 30_000;
const MIN_BUFFER = 50 * 1024 * 1024; // 50 MB floor
const BYTES_PER_LINE = 1024; // 1 KB estimate per line

export async function tailLines(filePath: string, maxLines: number): Promise<string[]> {
  if (maxLines <= 0) return [];

  try {
    const { stdout } = await execFileAsync("tail", ["-n", String(maxLines), filePath], {
      timeout: TIMEOUT_MS,
      maxBuffer: Math.max(MIN_BUFFER, maxLines * BYTES_PER_LINE),
    });

    if (!stdout.trim()) return [];
    // Remove only the final trailing newline, preserving line content
    const trimmed = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
    return trimmed.split("\n");
  } catch (err: any) {
    if (err.stderr?.includes("No such file or directory")) {
      const wrapped = new Error(`ENOENT: no such file '${filePath}'`) as NodeJS.ErrnoException;
      wrapped.code = "ENOENT";
      throw wrapped;
    }
    throw err;
  }
}
