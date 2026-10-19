import { describe, expect, it } from "vite-plus/test";

import {
  formatClaudeResumeCompactionQuestion,
  isClaudeResumeCompactionQuestion,
} from "./claudeCompaction.ts";

describe("Claude resume compaction copy", () => {
  it("formats and recognizes minute and hour ages", () => {
    const minutes = formatClaudeResumeCompactionQuestion({
      ageMinutes: 42,
      estimatedTokens: 123_456,
    });
    const hours = formatClaudeResumeCompactionQuestion({
      ageMinutes: 130,
      estimatedTokens: 900_000,
    });

    expect(minutes).toBe(
      "This session is 42m old and uses 123,456 tokens. Compact it before continuing?",
    );
    expect(hours).toBe(
      "This session is 2h 10m old and uses 900,000 tokens. Compact it before continuing?",
    );
    expect(isClaudeResumeCompactionQuestion(minutes)).toBe(true);
    expect(isClaudeResumeCompactionQuestion(hours)).toBe(true);
  });

  it("rejects unrelated questions", () => {
    expect(isClaudeResumeCompactionQuestion("Compact this conversation?")).toBe(false);
  });
});
