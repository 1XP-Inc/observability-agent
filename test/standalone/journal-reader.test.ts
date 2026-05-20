import { vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

// Use vi.hoisted so mockExecFileAsync is available inside vi.mock factory
const { mockExecFileAsync, mockSpawn } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockSpawn: vi.fn(),
}));

// Mock child_process.execFile with proper promisify custom symbol
// execFile uses Symbol.for('nodejs.util.promisify.custom') to return {stdout, stderr}
vi.mock("node:child_process", () => {
  const fn = vi.fn();
  fn[Symbol.for("nodejs.util.promisify.custom")] = mockExecFileAsync;
  return { execFile: fn, spawn: mockSpawn };
});

import { readJournalLines, streamJournalLines } from "../../src/standalone/journal-reader";

function setupSuccess(stdout: string) {
  mockExecFileAsync.mockResolvedValue({ stdout, stderr: "" });
}

function setupError(err: NodeJS.ErrnoException) {
  mockExecFileAsync.mockRejectedValue(err);
}

function setupSpawnResult(stdout: string, stderr: string = "", code: number | null = 0) {
  mockSpawn.mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    queueMicrotask(() => {
      child.stderr.end(stderr);
      child.stdout.end(stdout);
      child.emit("close", code);
    });
    return child;
  });
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

function callArgs(index: number): string[] {
  const call = mockExecFileAsync.mock.calls[index];
  return call[1] as string[];
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

  it("preserves system journal No entries output for compatibility", async () => {
    setupSuccess("-- No entries --\n");

    const lines = await readJournalLines({ unit: "nginx.service", maxLines: 100 });

    expect(lines).toEqual(["-- No entries --"]);
  });

  it("returns empty array when maxLines is 0", async () => {
    const lines = await readJournalLines({ unit: "nginx.service", maxLines: 0 });

    expect(lines).toEqual([]);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("resolves user journal users when maxLines is 0", async () => {
    const err = new Error("Command failed: id") as NodeJS.ErrnoException & { stderr?: string };
    err.code = "1";
    err.stderr = "id: 'missing': no such user";
    mockExecFileAsync.mockRejectedValue(err);

    await expect(
      readJournalLines({
        unit: "app.service",
        journalScope: "user",
        journalUser: "missing",
        maxLines: 0,
      }),
    ).rejects.toMatchObject({ code: "ENOUSER" });
    expect(callArgs(0)).toEqual(["-u", "missing"]);
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

  it("reads user journal with resolved username UID", async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "1000\n", stderr: "" })
      .mockResolvedValueOnce({
        stdout: "2026-05-15T03:45:01+0000 bera-beacond[123]: started\n",
        stderr: "",
      });

    const lines = await readJournalLines({
      unit: "bera-beacond.service",
      journalScope: "user",
      journalUser: "ubuntu",
      maxLines: 100,
      sinceSeconds: 900,
    });

    expect(lines).toEqual(["2026-05-15T03:45:01+0000 bera-beacond[123]: started"]);
    expect(callArgs(0)).toEqual(["-u", "ubuntu"]);
    expect(callArgs(1)).toEqual(
      expect.arrayContaining([
        "--user-unit",
        "bera-beacond.service",
        "_UID=1000",
        "--no-hostname",
        "--no-pager",
        "-o",
        "short-iso",
        "--since",
        "900 seconds ago",
      ]),
    );
  });

  it("reads user journal with numeric UID", async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "line\n", stderr: "" });

    await readJournalLines({
      unit: "bera-reth.service",
      journalScope: "user",
      journalUser: "1000",
      maxLines: 50,
    });

    expect(mockExecFileAsync).toHaveBeenCalledTimes(1);
    expect(callArgs(0)).toEqual(
      expect.arrayContaining(["--user-unit", "bera-reth.service", "_UID=1000"]),
    );
  });

  it("falls back to _SYSTEMD_USER_UNIT when --user-unit is unsupported", async () => {
    const unsupported = new Error("Command failed: journalctl") as NodeJS.ErrnoException & { stderr?: string };
    unsupported.code = "1";
    unsupported.stderr = "journalctl: unrecognized option '--user-unit'";
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "1000\n", stderr: "" })
      .mockRejectedValueOnce(unsupported)
      .mockResolvedValueOnce({ stdout: "fallback-line\n", stderr: "" });

    const lines = await readJournalLines({
      unit: "bera-beacond.service",
      journalScope: "user",
      journalUser: "ubuntu",
      maxLines: 25,
    });

    expect(lines).toEqual(["fallback-line"]);
    expect(callArgs(2)).toEqual(
      expect.arrayContaining(["_UID=1000", "_SYSTEMD_USER_UNIT=bera-beacond.service"]),
    );
    expect(callArgs(2)).not.toContain("--user-unit");
  });

  it("falls back to _SYSTEMD_USER_UNIT when --user-unit returns no output", async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "1000\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        stdout: "2026-05-15T03:45:01+0000 bera-beacond[123]: started\n",
        stderr: "",
      });

    const lines = await readJournalLines({
      unit: "bera-beacond.service",
      journalScope: "user",
      journalUser: "ubuntu",
      maxLines: 25,
    });

    expect(lines).toEqual(["2026-05-15T03:45:01+0000 bera-beacond[123]: started"]);
    expect(callArgs(1)).toEqual(
      expect.arrayContaining(["--user-unit", "bera-beacond.service", "_UID=1000"]),
    );
    expect(callArgs(2)).toEqual(
      expect.arrayContaining(["_UID=1000", "_SYSTEMD_USER_UNIT=bera-beacond.service"]),
    );
  });

  it("falls back to _SYSTEMD_USER_UNIT when --user-unit returns No entries", async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "1000\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "-- No entries --\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "fallback-line\n", stderr: "" });

    const lines = await readJournalLines({
      unit: "bera-beacond.service",
      journalScope: "user",
      journalUser: "ubuntu",
      maxLines: 25,
    });

    expect(lines).toEqual(["fallback-line"]);
    expect(callArgs(2)).toEqual(
      expect.arrayContaining(["_UID=1000", "_SYSTEMD_USER_UNIT=bera-beacond.service"]),
    );
  });

  it("returns empty array when user journal primary and fallback have no entries", async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "1000\n", stderr: "" })
      .mockResolvedValueOnce({ stdout: "", stderr: "" })
      .mockResolvedValueOnce({ stdout: "-- No entries --\n", stderr: "" });

    const lines = await readJournalLines({
      unit: "bera-beacond.service",
      journalScope: "user",
      journalUser: "ubuntu",
      maxLines: 25,
    });

    expect(lines).toEqual([]);
    expect(mockExecFileAsync).toHaveBeenCalledTimes(3);
  });

  it("throws ENOUSER when journalUser cannot be resolved", async () => {
    const err = new Error("Command failed: id") as NodeJS.ErrnoException & { stderr?: string };
    err.code = "1";
    err.stderr = "id: 'missing': no such user";
    mockExecFileAsync.mockRejectedValue(err);

    await expect(
      readJournalLines({
        unit: "app.service",
        journalScope: "user",
        journalUser: "missing",
        maxLines: 100,
      }),
    ).rejects.toMatchObject({ code: "ENOUSER" });
  });

  it("throws EINVAL for malformed numeric journalUser", async () => {
    await expect(
      readJournalLines({
        unit: "app.service",
        journalScope: "user",
        journalUser: "-1",
        maxLines: 100,
      }),
    ).rejects.toMatchObject({ code: "EINVAL" });
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("throws EINVAL for out-of-range numeric journalUser", async () => {
    await expect(
      readJournalLines({
        unit: "app.service",
        journalScope: "user",
        journalUser: "4294967296",
        maxLines: 100,
      }),
    ).rejects.toMatchObject({ code: "EINVAL" });
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it("throws EACCES when user journal stderr contains permission hint", async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: "1000\n", stderr: "" })
      .mockResolvedValueOnce({
        stdout: "",
        stderr: "Failed to open journal: Permission denied",
      });

    await expect(
      readJournalLines({
        unit: "app.service",
        journalScope: "user",
        journalUser: "ubuntu",
        maxLines: 100,
      }),
    ).rejects.toMatchObject({ code: "EACCES" });
  });
});

describe("streamJournalLines", () => {
  it("resolves user journal users when maxLines is 0 before streaming", async () => {
    const err = new Error("Command failed: id") as NodeJS.ErrnoException & { stderr?: string };
    err.code = "1";
    err.stderr = "id: 'missing': no such user";
    mockExecFileAsync.mockRejectedValue(err);

    await expect(
      streamJournalLines(
        {
          unit: "app.service",
          journalScope: "user",
          journalUser: "missing",
          maxLines: 0,
        },
        vi.fn(),
      ),
    ).rejects.toMatchObject({ code: "ENOUSER" });
    expect(callArgs(0)).toEqual(["-u", "missing"]);
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it("strips system journal No entries output in the streaming path", async () => {
    setupSpawnResult("-- No entries --\n");
    const lines: string[] = [];

    const count = await streamJournalLines(
      { unit: "nginx.service", maxLines: 100 },
      (line) => { lines.push(line); },
    );

    expect(count).toBe(0);
    expect(lines).toEqual([]);
    expect(mockSpawn).toHaveBeenCalledWith(
      "journalctl",
      expect.arrayContaining(["-u", "nginx.service", "-n", "100", "--no-pager", "-o", "short-iso"]),
      expect.objectContaining({ stdio: ["ignore", "pipe", "pipe"] }),
    );
  });

  it("streams system journal lines after filtering only No entries markers", async () => {
    setupSpawnResult(
      "-- No entries --\n" +
      "2024-01-15T10:30:00+0000 host nginx[123]: request received\n",
    );
    const lines: string[] = [];

    const count = await streamJournalLines(
      { unit: "nginx.service", maxLines: 100 },
      async (line) => { lines.push(line); },
    );

    expect(count).toBe(1);
    expect(lines).toEqual(["2024-01-15T10:30:00+0000 host nginx[123]: request received"]);
  });
});
