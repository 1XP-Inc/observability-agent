import { vi } from "vitest";

// Use vi.hoisted so mockExecFileAsync is available inside vi.mock factory
const { mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
}));

// Mock child_process.execFile with proper promisify custom symbol
// execFile uses Symbol.for('nodejs.util.promisify.custom') to return {stdout, stderr}
vi.mock("node:child_process", () => {
  const fn = vi.fn();
  fn[Symbol.for("nodejs.util.promisify.custom")] = mockExecFileAsync;
  return { execFile: fn };
});

import { readJournalLines } from "../../src/standalone/journal-reader";

function setupSuccess(stdout: string) {
  mockExecFileAsync.mockResolvedValue({ stdout, stderr: "" });
}

function setupError(err: NodeJS.ErrnoException) {
  mockExecFileAsync.mockRejectedValue(err);
}

function lastCallArgs(): string[] {
  const call = mockExecFileAsync.mock.calls[mockExecFileAsync.mock.calls.length - 1];
  // args are: (cmd, args, opts)
  return call[1] as string[];
}

function lastCallOptions(): Record<string, any> {
  const call = mockExecFileAsync.mock.calls[mockExecFileAsync.mock.calls.length - 1];
  return call[2] as Record<string, any>;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readJournalLines", () => {
  it("returns parsed lines from journalctl output", async () => {
    setupSuccess(
      "2024-01-15T10:30:00+0000 host nginx[123]: request received\n" +
      "2024-01-15T10:30:01+0000 host nginx[123]: request completed\n"
    );

    const lines = await readJournalLines({ unit: "nginx.service", maxLines: 100 });

    expect(lines).toEqual([
      "2024-01-15T10:30:00+0000 host nginx[123]: request received",
      "2024-01-15T10:30:01+0000 host nginx[123]: request completed",
    ]);
    expect(lastCallArgs()).toContain("-u");
    expect(lastCallArgs()).toContain("nginx.service");
  });

  it("returns empty array for empty output", async () => {
    setupSuccess("");

    const lines = await readJournalLines({ unit: "nginx.service", maxLines: 100 });

    expect(lines).toEqual([]);
  });

  it("returns empty array for whitespace-only output", async () => {
    setupSuccess("  \n  \n");

    const lines = await readJournalLines({ unit: "nginx.service", maxLines: 100 });

    expect(lines).toEqual([]);
  });

  it("returns empty array when maxLines is 0", async () => {
    const lines = await readJournalLines({ unit: "nginx.service", maxLines: 0 });

    expect(lines).toEqual([]);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("passes sinceSeconds as --since argument", async () => {
    setupSuccess("2024-01-15T10:30:00+0000 host unit[1]: msg\n");

    await readJournalLines({ unit: "app.service", maxLines: 50, sinceSeconds: 600 });

    const args = lastCallArgs();
    expect(args).toContain("--since");
    expect(args).toContain("600 seconds ago");
  });

  it("passes absolute time window as --since/--until", async () => {
    setupSuccess("2024-01-15T10:30:00+0000 host unit[1]: msg\n");

    await readJournalLines({
      unit: "app.service",
      maxLines: 50,
      sinceTime: "2024-01-15T10:00:00Z",
      untilTime: "2024-01-15T11:00:00Z",
    });

    const args = lastCallArgs();
    expect(args).toContain("--since");
    expect(args).toContain("2024-01-15T10:00:00Z");
    expect(args).toContain("--until");
    expect(args).toContain("2024-01-15T11:00:00Z");
  });

  it("passes sinceTime without untilTime", async () => {
    setupSuccess("line\n");

    await readJournalLines({
      unit: "app.service",
      maxLines: 50,
      sinceTime: "2024-01-15T10:00:00Z",
    });

    const args = lastCallArgs();
    expect(args).toContain("--since");
    expect(args).toContain("2024-01-15T10:00:00Z");
    expect(args).not.toContain("--until");
  });

  it("throws ENOENT when journalctl is not installed", async () => {
    const err = new Error("spawn journalctl ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    setupError(err);

    await expect(
      readJournalLines({ unit: "nginx.service", maxLines: 100 }),
    ).rejects.toThrow("ENOENT");
  });

  it("throws on other errors", async () => {
    const err = new Error("permission denied") as NodeJS.ErrnoException;
    err.code = "EPERM";
    setupError(err);

    await expect(
      readJournalLines({ unit: "nginx.service", maxLines: 100 }),
    ).rejects.toThrow("permission denied");
  });

  it("throws EACCES when rejected process stderr contains permission hint", async () => {
    const err = new Error("Command failed: journalctl") as NodeJS.ErrnoException & { stderr?: string };
    err.code = "1";
    err.stderr = "Hint: You are currently not seeing messages from other users and the system.";
    setupError(err);

    await expect(
      readJournalLines({ unit: "nginx.service", maxLines: 100 }),
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("throws EACCES when stderr contains permission hint", async () => {
    mockExecFileAsync.mockResolvedValue({
      stdout: "",
      stderr: "Hint: You are currently not seeing messages from other users and the system.\nUsers in groups 'adm', 'systemd-journal' can see all messages.",
    });

    await expect(
      readJournalLines({ unit: "nginx.service", maxLines: 100 }),
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("throws EACCES when stderr contains 'Permission denied'", async () => {
    mockExecFileAsync.mockResolvedValue({
      stdout: "",
      stderr: "Failed to open journal: Permission denied",
    });

    await expect(
      readJournalLines({ unit: "nginx.service", maxLines: 100 }),
    ).rejects.toMatchObject({ code: "EACCES" });
  });

  it("includes correct base arguments", async () => {
    setupSuccess("line\n");

    await readJournalLines({ unit: "test.service", maxLines: 200 });

    const args = lastCallArgs();
    expect(args).toEqual(
      expect.arrayContaining(["-u", "test.service", "-n", "200", "--no-pager", "-o", "short-iso"]),
    );
  });

  it("forces C locale for stable journalctl permission messages", async () => {
    setupSuccess("line\n");

    await readJournalLines({ unit: "test.service", maxLines: 200 });

    expect(lastCallOptions().env).toMatchObject({ LANG: "C", LC_ALL: "C" });
  });
});
