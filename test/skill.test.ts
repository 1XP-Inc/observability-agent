import { vi } from "vitest";

vi.mock("node:fs", () => {
  const mockReadFileSync = vi.fn();
  return {
    default: { readFileSync: mockReadFileSync },
    readFileSync: mockReadFileSync,
  };
});

import fs from "node:fs";
import { loadSkillMarkdown } from "../src/skill";

// fs.readFileSync 가 vi.fn() 이므로 타입 캐스팅
const mockReadFileSync = fs.readFileSync as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockReadFileSync.mockReset();
});

describe("loadSkillMarkdown", () => {
  it("첫 번째 후보 경로에서 파일을 읽을 수 있으면 해당 내용을 반환한다", () => {
    mockReadFileSync.mockReturnValueOnce("# Skill Content");

    const result = loadSkillMarkdown();

    expect(result).toBe("# Skill Content");
    expect(mockReadFileSync).toHaveBeenCalledTimes(1);
  });

  it("첫 번째 후보가 실패하면 두 번째 후보에서 읽는다", () => {
    mockReadFileSync
      .mockImplementationOnce(() => {
        throw new Error("ENOENT: no such file");
      })
      .mockReturnValueOnce("# Fallback Content");

    const result = loadSkillMarkdown();

    expect(result).toBe("# Fallback Content");
    expect(mockReadFileSync).toHaveBeenCalledTimes(2);
  });

  it("모든 후보가 실패하면 에러를 던진다", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT: no such file");
    });

    expect(() => loadSkillMarkdown()).toThrow("Unable to read skill.md from:");
  });

  it("에러 메시지에 후보 경로들이 포함된다", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(() => loadSkillMarkdown()).toThrow(/skill\.md/);
  });
});
