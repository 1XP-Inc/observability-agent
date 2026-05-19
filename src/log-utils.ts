export function parseLogLine(line: string, timestamps: boolean): { ts?: string; msg: string } {
  if (!timestamps) return { msg: line };
  const idx = line.indexOf(" ");
  if (idx <= 0) return { msg: line };
  const ts = line.slice(0, idx);
  const msg = line.slice(idx + 1);
  return { ts, msg };
}

export function shouldExcludeLine(msg: string, excludePatterns: string[]): boolean {
  for (const pat of excludePatterns) {
    if (msg.includes(pat)) return true;
  }
  return false;
}

export function shouldIncludeLine(msg: string, includePatterns: string[]): boolean {
  if (includePatterns.length === 0) return true;
  for (const pat of includePatterns) {
    if (msg.includes(pat)) return true;
  }
  return false;
}

export function parseLineTimeMs(ts: string | undefined): number | undefined {
  if (!ts) return undefined;
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms) || Number.isNaN(ms)) return undefined;
  return ms;
}
