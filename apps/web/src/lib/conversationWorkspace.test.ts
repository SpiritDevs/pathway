import { describe, expect, it } from "vite-plus/test";
import {
  isConversationRepositoryRoot,
  resolveConversationReviewWorkspace,
} from "./conversationWorkspace";

const input = {
  projectPath: "/project/worktree",
  conversationPath: "/userdata/conversations/one",
  selectedPath: null,
  conversationGitStatus: {
    isRepo: true,
    hasWorkingTreeChanges: false,
    aheadCount: 0,
    hasUpstream: true,
  },
};

describe("conversation review folders", () => {
  it.each([{ hasWorkingTreeChanges: true }, { aheadCount: 2 }, { hasUpstream: false }])(
    "reveals unfinished work in the original folder: %o",
    (status) => {
      expect(
        resolveConversationReviewWorkspace({
          ...input,
          conversationGitStatus: { ...input.conversationGitStatus, ...status },
        }),
      ).toBe(input.conversationPath);
    },
  );
  it("keeps a selected folder stable while statuses refresh", () => {
    expect(
      resolveConversationReviewWorkspace({
        ...input,
        selectedPath: input.projectPath,
        conversationGitStatus: { ...input.conversationGitStatus, hasWorkingTreeChanges: true },
      }),
    ).toBe(input.projectPath);
  });
  it("never applies a folder selected in a different thread", () => {
    expect(resolveConversationReviewWorkspace({ ...input, selectedPath: "/other/thread" })).toBe(
      input.projectPath,
    );
  });
  it("uses the conversation folder without a project", () => {
    expect(resolveConversationReviewWorkspace({ ...input, projectPath: null })).toBe(
      input.conversationPath,
    );
  });
});

describe("conversation Git root", () => {
  it("rejects an unrelated ancestor repository around development userdata", () => {
    expect(isConversationRepositoryRoot("/repo/.pathway/userdata/conversations/one", "/repo")).toBe(
      false,
    );
  });
  it("does not treat a nested repository as the root folder's diff", () => {
    expect(
      isConversationRepositoryRoot(
        "/userdata/conversations/one",
        "/userdata/conversations/one/clone",
      ),
    ).toBe(false);
  });
  it("allows a repository initialized at the conversation root", () => {
    expect(
      isConversationRepositoryRoot("/userdata/conversations/one/", "/userdata/conversations/one"),
    ).toBe(true);
  });
  it("keeps Git reads disabled while inspection is unavailable", () => {
    expect(isConversationRepositoryRoot("/userdata/conversations/one", undefined)).toBe(false);
    expect(isConversationRepositoryRoot("/userdata/conversations/one", null)).toBe(false);
  });
});
