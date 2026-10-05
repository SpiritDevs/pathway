import { describe, expect, it } from "vite-plus/test";

import {
  appendWorkflowSkillPrompt,
  removeWorkflowSkillPrompt,
} from "./composerWorkflowRecording.logic";

const PROMPT = "Create a reusable skill from the workflow I just recorded.";

describe("appendWorkflowSkillPrompt", () => {
  it("appends after the existing draft with a blank line", () => {
    expect(appendWorkflowSkillPrompt("Keep this  \n", PROMPT)).toBe(`Keep this\n\n${PROMPT}`);
    expect(appendWorkflowSkillPrompt("", PROMPT)).toBe(PROMPT);
  });

  it("never appends the same prompt twice", () => {
    const once = appendWorkflowSkillPrompt("Keep this", PROMPT);
    expect(appendWorkflowSkillPrompt(once, PROMPT)).toBe(once);
  });
});

describe("removeWorkflowSkillPrompt", () => {
  it("takes back only the hand-off prompt", () => {
    expect(removeWorkflowSkillPrompt(`Keep this\n\n${PROMPT}`, PROMPT)).toBe("Keep this");
    expect(removeWorkflowSkillPrompt(`${PROMPT}\n\nAnd this`, PROMPT)).toBe("\n\nAnd this");
    expect(removeWorkflowSkillPrompt(PROMPT, PROMPT)).toBe("");
  });

  it("leaves a draft without the exact prompt alone", () => {
    expect(removeWorkflowSkillPrompt("Edited prompt", PROMPT)).toBe("Edited prompt");
  });
});
