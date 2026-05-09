import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 10_000;
const MIN_BUFFER = 10 * 1024 * 1024; // 10 MB floor
const BYTES_PER_LINE = 1024; // 1 KB estimate per line

function isJournalPermissionHint(stderr: unknown): boolean {
  return typeof stderr === "string" && /not seeing messages from other users|permission denied/i.test(stderr);
}

function toPermissionError(stderr: string): NodeJS.ErrnoException {
  const err = new Error(stderr.trim()) as NodeJS.ErrnoException;
  err.code = "EACCES";
  return err;
}

export async function readJournalLines(params: {
  unit: string;
  maxLines: number;
  sinceSeconds?: number;
  sinceTime?: string;
  untilTime?: string;
}): Promise<string[]> {
  const { unit, maxLines, sinceSeconds, sinceTime, untilTime } = params;
  if (maxLines <= 0) return [];

  const args = ["-u", unit, "-n", String(maxLines), "--no-pager", "-o", "short-iso"];

  if (sinceTime) {
    args.push("--since", sinceTime);
    if (untilTime) args.push("--until", untilTime);
  } else if (sinceSeconds != null) {
    args.push("--since", `${sinceSeconds} seconds ago`);
  }

  let stdout: string;
  let stderr: string;
  try {
    const result = await execFileAsync("journalctl", args, {
      timeout: TIMEOUT_MS,
      maxBuffer: Math.max(MIN_BUFFER, maxLines * BYTES_PER_LINE),
    });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (err: any) {
    if (isJournalPermissionHint(err?.stderr)) {
      throw toPermissionError(err.stderr);
    }
    throw err;
  }

  if (isJournalPermissionHint(stderr)) {
    throw toPermissionError(stderr);
  }

  if (!stdout.trim()) return [];
  return stdout.trimEnd().split("\n");
}
