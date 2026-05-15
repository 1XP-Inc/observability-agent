import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { JournalScope } from "./types";

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = 10_000;
const MIN_BUFFER = 10 * 1024 * 1024; // 10 MB floor
const BYTES_PER_LINE = 1024; // 1 KB estimate per line
const EXEC_ENV = { ...process.env, LANG: "C", LC_ALL: "C" };

function isJournalPermissionHint(stderr: unknown): boolean {
  return typeof stderr === "string" && /not seeing messages from other users|permission denied/i.test(stderr);
}

function codedError(message: string, code: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function toPermissionError(stderr: string): NodeJS.ErrnoException {
  return codedError(stderr.trim(), "EACCES");
}

function toJournalUserError(journalUser: string, stderr?: unknown): NodeJS.ErrnoException {
  const detail = typeof stderr === "string" && stderr.trim() ? `: ${stderr.trim()}` : "";
  return codedError(`journalUser "${journalUser}" was not found or is not a valid UID${detail}`, "ENOUSER");
}

function parseNumericUid(journalUser: string): string | undefined {
  if (!/^\d+$/.test(journalUser)) return undefined;
  const uid = BigInt(journalUser);
  if (uid > 4_294_967_295n) {
    throw codedError(`journalUser "${journalUser}" is outside the valid UID range`, "EINVAL");
  }
  return uid.toString();
}

function isUnsupportedUserUnitError(err: any): boolean {
  const text = `${err?.stderr ?? ""}\n${err?.message ?? ""}`;
  return /(?:unrecognized|unknown|invalid)\s+(?:option|argument).*user-unit/i.test(text);
}

function execOptions(maxBuffer: number) {
  return {
    timeout: TIMEOUT_MS,
    maxBuffer,
    env: EXEC_ENV,
  };
}

async function execJournalctl(args: string[], maxLines: number): Promise<{ stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync("journalctl", args, execOptions(Math.max(MIN_BUFFER, maxLines * BYTES_PER_LINE)));
    if (isJournalPermissionHint(result.stderr)) {
      throw toPermissionError(result.stderr);
    }
    return result;
  } catch (err: any) {
    if (isJournalPermissionHint(err?.stderr)) {
      throw toPermissionError(err.stderr);
    }
    throw err;
  }
}

async function resolveJournalUserUid(journalUser: string): Promise<string> {
  const trimmed = journalUser.trim();
  if (!trimmed) {
    throw codedError("journalUser must be a non-empty username or UID", "EINVAL");
  }
  const numericUid = parseNumericUid(trimmed);
  if (numericUid != null) return numericUid;
  if (/^-?\d+$/.test(trimmed) || trimmed.startsWith("-")) {
    throw codedError(`journalUser "${trimmed}" must be a non-negative UID or existing username`, "EINVAL");
  }

  try {
    const result = await execFileAsync("id", ["-u", trimmed], execOptions(MIN_BUFFER));
    const uid = result.stdout.trim();
    if (!/^\d+$/.test(uid)) {
      throw codedError(`id -u returned an invalid UID for journalUser "${trimmed}"`, "EINVAL");
    }
    return uid;
  } catch (err: any) {
    if (err?.code === "EINVAL") throw err;
    throw toJournalUserError(trimmed, err?.stderr ?? err?.message);
  }
}

function appendTimeArgs(args: string[], params: {
  sinceSeconds?: number;
  sinceTime?: string;
  untilTime?: string;
}): void {
  if (params.sinceTime) {
    args.push("--since", params.sinceTime);
    if (params.untilTime) args.push("--until", params.untilTime);
  } else if (params.sinceSeconds != null) {
    args.push("--since", `${params.sinceSeconds} seconds ago`);
  }
}

function journalLinesFromStdout(stdout: string, opts?: { stripNoEntries?: boolean }): string[] {
  const lines = stdout.trimEnd().split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  if (!opts?.stripNoEntries) return lines;
  return lines.filter((line) => !/^--\s*No entries\s*--$/.test(line.trim()));
}

export async function readJournalLines(params: {
  unit: string;
  journalScope?: JournalScope;
  journalUser?: string;
  maxLines: number;
  sinceSeconds?: number;
  sinceTime?: string;
  untilTime?: string;
}): Promise<string[]> {
  const { unit, maxLines, sinceSeconds, sinceTime, untilTime } = params;
  if (maxLines <= 0) return [];

  if ((params.journalScope ?? "system") === "user") {
    if (!params.journalUser) {
      throw codedError("journalUser is required for user journal scope", "EINVAL");
    }
    const uid = await resolveJournalUserUid(params.journalUser);
    const args = ["--user-unit", unit, `_UID=${uid}`, "-n", String(maxLines), "--no-hostname", "--no-pager", "-o", "short-iso"];
    appendTimeArgs(args, { sinceSeconds, sinceTime, untilTime });

    try {
      const result = await execJournalctl(args, maxLines);
      const lines = journalLinesFromStdout(result.stdout, { stripNoEntries: true });
      if (lines.length > 0) return lines;
    } catch (err: any) {
      if (!isUnsupportedUserUnitError(err)) throw err;
    }
    const fallbackArgs = [`_UID=${uid}`, `_SYSTEMD_USER_UNIT=${unit}`, "-n", String(maxLines), "--no-hostname", "--no-pager", "-o", "short-iso"];
    appendTimeArgs(fallbackArgs, { sinceSeconds, sinceTime, untilTime });
    const result = await execJournalctl(fallbackArgs, maxLines);
    return journalLinesFromStdout(result.stdout, { stripNoEntries: true });
  }

  const args = ["-u", unit, "-n", String(maxLines), "--no-pager", "-o", "short-iso"];
  appendTimeArgs(args, { sinceSeconds, sinceTime, untilTime });
  const result = await execJournalctl(args, maxLines);
  return journalLinesFromStdout(result.stdout);
}
