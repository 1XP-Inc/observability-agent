import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 10_000;
const MIN_BUFFER = 10 * 1024 * 1024; // 10 MB floor
const BYTES_PER_LINE = 1024; // 1 KB estimate per line

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

  const { stdout, stderr } = await execFileAsync("journalctl", args, {
    timeout: TIMEOUT_MS,
    maxBuffer: Math.max(MIN_BUFFER, maxLines * BYTES_PER_LINE),
  });

  if (stderr && /not seeing messages from other users|permission denied/i.test(stderr)) {
    const err = new Error(stderr.trim()) as NodeJS.ErrnoException;
    err.code = "EACCES";
    throw err;
  }

  if (!stdout.trim()) return [];
  return stdout.trimEnd().split("\n");
}
