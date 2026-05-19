import { parseLineTimeMs, parseLogLine } from "../src/log-utils";

describe("log-utils", () => {
  it("preserves spaced untimestamped lines as the full message", () => {
    expect(parseLogLine("ERROR disk full", true)).toEqual({ msg: "ERROR disk full" });
  });

  it("splits timestamped lines into timestamp and message", () => {
    expect(parseLogLine("2024-01-01T00:00:00Z hello world", true)).toEqual({
      ts: "2024-01-01T00:00:00Z",
      msg: "hello world",
    });
  });

  it("does not treat arbitrary parseable numbers as timestamps", () => {
    expect(parseLineTimeMs("123")).toBeUndefined();
    expect(parseLogLine("123 status code", true)).toEqual({ msg: "123 status code" });
  });

  it("keeps the full line when timestamp splitting is disabled", () => {
    expect(parseLogLine("2024-01-01T00:00:00Z hello", false)).toEqual({ msg: "2024-01-01T00:00:00Z hello" });
  });
});
