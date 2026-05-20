export function parseLogLine(line: string, timestamps: boolean): { ts?: string; msg: string } {
  if (!timestamps) return { msg: line };
  const idx = line.indexOf(" ");
  if (idx <= 0) return { msg: line };
  const ts = line.slice(0, idx);
  if (parseLineTimeMs(ts) == null) return { msg: line };
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

function daysInMonth(year: number, month: number): number {
  if (month < 1 || month > 12) return 0;
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

export function parseLineTimeMs(ts: string | undefined): number | undefined {
  if (!ts) return undefined;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:[.,]\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/.exec(ts);
  if (!match) {
    return undefined;
  }
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw] = match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  if (
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return undefined;
  }
  const ms = Date.parse(ts);
  if (!Number.isFinite(ms) || Number.isNaN(ms)) return undefined;
  return ms;
}
