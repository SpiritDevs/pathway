import { describe, expect, it } from "vite-plus/test";
import type { PromptStashEntry } from "../../promptStashStore";
import {
  appendStashedPrompt,
  stashEntryMatchesQuery,
  stashEntrySnippet,
} from "./composerPromptStash.logic";

const entry: PromptStashEntry = {
  id: "saved",
  createdAt: "2026-10-01T00:00:00Z",
  prompt: "Review the checkout flow",
  attachments: [],
  droppedImageNames: [],
};

describe("stashed prompt presentation", () => {
  it("uses compact text while searching the full prompt", () => {
    const long = { ...entry, prompt: `  Review\n\n${"checkout ".repeat(15)}regressions` };
    expect(stashEntrySnippet(long)).toHaveLength(91);
    expect(stashEntrySnippet(long)).toMatch(/^Review checkout.*…$/);
    expect(stashEntryMatchesQuery(long, "REGRESSIONS")).toBe(true);
  });

  it("labels attachment-only prompts while encoding and after failures", () => {
    expect(stashEntrySnippet({ ...entry, prompt: "", pendingImageCount: 2 })).toBe("2 attachments");
    expect(stashEntrySnippet({ ...entry, prompt: "", unreadableImageNames: ["shot.png"] })).toBe(
      "1 attachment",
    );
    expect(stashEntrySnippet({ ...entry, prompt: "" })).toBe("Empty prompt");
  });

  it("searches saved attachment names", () => {
    const file = {
      ...entry,
      attachments: [
        {
          type: "file" as const,
          id: "file",
          name: "report.pdf",
          mimeType: "application/pdf",
          sizeBytes: 10,
        },
      ],
    };
    expect(stashEntryMatchesQuery(file, "REPORT.PDF")).toBe(true);
    expect(stashEntryMatchesQuery(file, "missing")).toBe(false);
  });
});

describe("restoring prompt text", () => {
  it("preserves unfinished work and inserts a paragraph boundary", () => {
    expect(appendStashedPrompt("Unfinished draft  \n", entry.prompt)).toBe(
      `Unfinished draft\n\n${entry.prompt}`,
    );
  });
  it("restores into an empty draft", () => {
    expect(appendStashedPrompt("  ", entry.prompt)).toBe(entry.prompt);
  });
  it("leaves text and whitespace intact for attachment-only prompts", () => {
    expect(appendStashedPrompt("Unfinished draft  \n", "")).toBe("Unfinished draft  \n");
  });
});
