import { describe, expect, it } from "vite-plus/test";

import { hasClaudeSkillMention, planClaudeSkillDispatch } from "./ClaudeSkillDispatch.ts";

const SKILLS = new Set(["implement", "review", "re-release-version"]);

describe("planClaudeSkillDispatch", () => {
  it("leaves a prompt without a known skill untouched", () => {
    expect(planClaudeSkillDispatch("fix the build", SKILLS)).toBeUndefined();
    // Not a discovered skill, so it stays prose rather than becoming a command.
    expect(planClaudeSkillDispatch("echo $HOME then $unknown", SKILLS)).toBeUndefined();
  });

  it("moves a mid-prompt mention into a trailing slash command", () => {
    expect(planClaudeSkillDispatch("ok, now $implement all the tickets", SKILLS)).toEqual({
      leadingText: "ok, now",
      commandText: "/implement all the tickets",
      skillName: "implement",
    });
  });

  it("keeps a mention that opens the prompt as a single command block", () => {
    expect(planClaudeSkillDispatch("$review\nfocus on auth", SKILLS)).toEqual({
      leadingText: undefined,
      commandText: "/review\nfocus on auth",
      skillName: "review",
    });
  });

  it("dispatches the last mention and rewrites earlier ones inline", () => {
    expect(planClaudeSkillDispatch("$review the diff, then $implement the fixes", SKILLS)).toEqual({
      leadingText: "/review the diff, then",
      commandText: "/implement the fixes",
      skillName: "implement",
    });
  });

  it("ignores a dollar token glued to other text", () => {
    expect(planClaudeSkillDispatch("cost is 5$implement", SKILLS)).toBeUndefined();
  });
});

describe("hasClaudeSkillMention", () => {
  it.each(["The budget is $100", "cost $1,000", "a lone $", "cost is 5$implement", "echo ${HOME}"])(
    "skips discovery for %s",
    (prompt) => {
      expect(hasClaudeSkillMention(prompt)).toBe(false);
    },
  );
  it.each(["$implement", "please $review the diff", "$plugin:review\nnow", "$review $implement"])(
    "discovers possible skills in %s",
    (prompt) => {
      expect(hasClaudeSkillMention(prompt)).toBe(true);
      expect(hasClaudeSkillMention(prompt)).toBe(true);
    },
  );
});
