import fs from "node:fs";
import path from "node:path";

export function loadSkillMarkdown(): string {
  const candidates = [
    path.join(process.cwd(), "skill.md"),
    path.join(__dirname, "..", "skill.md"),
  ];

  for (const p of candidates) {
    try {
      return fs.readFileSync(p, "utf8");
    } catch {
      // continue
    }
  }

  throw new Error(`Unable to read skill.md from: ${candidates.join(", ")}`);
}
