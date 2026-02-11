import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 10_000;
const MAX_BUFFER = 10 * 1024 * 1024; // 10 MB

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

  const { stdout } = await execFileAsync("journalctl", args, {
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
  });

  if (!stdout.trim()) return [];
  return stdout.trimEnd().split("\n");
}
