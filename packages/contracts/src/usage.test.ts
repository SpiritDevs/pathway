import { describe, expect, it } from "@effect/vitest";

import { transcriptWorkspaceSlug } from "./usage.ts";

describe("transcript workspace slug", () => {
  it("encodes a posix path the way the provider CLIs name their transcript directory", () => {
    expect(transcriptWorkspaceSlug("/Users/ada/GitHub/pathway")).toBe("-Users-ada-GitHub-pathway");
  });

  it("flattens the separators a directory name can carry", () => {
    // Underscores, dots, and spaces are all replaced, so a project root has exactly one encoding.
    expect(transcriptWorkspaceSlug("/Users/ada/src/my_project")).toBe("-Users-ada-src-my-project");
    expect(transcriptWorkspaceSlug("/Users/ada/src/site.v2")).toBe("-Users-ada-src-site-v2");
    expect(transcriptWorkspaceSlug("/Users/ada/My Projects/app")).toBe(
      "-Users-ada-My-Projects-app",
    );
  });

  it("encodes a Windows path", () => {
    expect(transcriptWorkspaceSlug("C:\\Users\\ada\\src\\pathway")).toBe(
      "C--Users-ada-src-pathway",
    );
  });

  it("is stable, which is the only property matching relies on", () => {
    // The encoding is deliberately not reversible: a directory whose real name contains a dash is
    // indistinguishable from a separator. Matching therefore only ever runs in this direction.
    const root = "/Users/ada/GitHub/pathway";
    expect(transcriptWorkspaceSlug(root)).toBe(transcriptWorkspaceSlug(root));
  });
});
