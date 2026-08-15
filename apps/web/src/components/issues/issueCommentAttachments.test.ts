import {
  ChatAttachmentId,
  ISSUE_COMMENT_ATTACHMENT_MAX_DATA_URL_CHARS,
  ISSUE_COMMENT_MAX_ATTACHMENTS,
  IssueCommentId,
  IssueId,
  type IssueComment,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  issueAttachmentComment,
  issueAttachmentIds,
  issueAttachmentReferences,
  isIssueVideoAttachmentUrl,
  issueCommentAttachmentDataUrlRejection,
  issueCommentAttachmentIds,
  issueCommentAttachmentIntake,
  issueCommentAttachmentTooLargeMessage,
  issueCommentComposerState,
  type IssueCommentAttachmentDraft,
} from "./issueCommentAttachments";

it("identifies issue video evidence from signed attachment URLs", () => {
  expect(
    isIssueVideoAttachmentUrl("https://pathway.test/api/assets/token/browser-recording-proof.webm"),
  ).toBe(true);
  expect(isIssueVideoAttachmentUrl("https://pathway.test/api/assets/token/screenshot.png")).toBe(
    false,
  );
});

const png = { type: "image/png" } as const;
const text = { type: "text/plain" } as const;

function uploaded(draftId: string): IssueCommentAttachmentDraft {
  return {
    draftId,
    name: `${draftId}.png`,
    previewUrl: `blob:${draftId}`,
    status: "uploaded",
    attachmentId: ChatAttachmentId.make(`iss_${draftId}`),
  };
}

function uploading(draftId: string): IssueCommentAttachmentDraft {
  return {
    draftId,
    name: `${draftId}.png`,
    previewUrl: `blob:${draftId}`,
    status: "uploading",
  };
}

describe("issueCommentAttachmentIntake", () => {
  it("takes every image when there is room", () => {
    const result = issueCommentAttachmentIntake({ files: [png, png], currentCount: 0 });
    expect(result.accepted).toHaveLength(2);
    expect(result.rejection).toBeNull();
  });

  it("says nothing about a paste that carried no files at all", () => {
    expect(issueCommentAttachmentIntake({ files: [], currentCount: 0 })).toEqual({
      accepted: [],
      rejection: null,
    });
  });

  it("refuses a drop of non-images outright", () => {
    const result = issueCommentAttachmentIntake({ files: [text], currentCount: 0 });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejection).toBe("Only images can be attached to a comment.");
  });

  it("keeps the images out of a mixed drop and counts what it skipped", () => {
    const result = issueCommentAttachmentIntake({ files: [png, text, text], currentCount: 0 });
    expect(result.accepted).toEqual([png]);
    expect(result.rejection).toBe(
      "Only images can be attached to a comment, so 2 files were skipped.",
    );
  });

  it("fills the remaining slots and reports the surplus", () => {
    const result = issueCommentAttachmentIntake({
      files: [png, png, png],
      currentCount: ISSUE_COMMENT_MAX_ATTACHMENTS - 1,
    });
    expect(result.accepted).toHaveLength(1);
    expect(result.rejection).toBe(
      `A comment holds at most ${ISSUE_COMMENT_MAX_ATTACHMENTS} images, so 2 were not attached.`,
    );
  });

  it("takes nothing once the comment is full", () => {
    const result = issueCommentAttachmentIntake({
      files: [png],
      currentCount: ISSUE_COMMENT_MAX_ATTACHMENTS,
    });
    expect(result.accepted).toHaveLength(0);
    expect(result.rejection).toBe(
      `A comment holds at most ${ISSUE_COMMENT_MAX_ATTACHMENTS} images.`,
    );
  });
});

describe("issueCommentAttachmentDataUrlRejection", () => {
  it("passes a payload inside the wire bound", () => {
    expect(
      issueCommentAttachmentDataUrlRejection({
        name: "shot.png",
        dataUrl: "data:image/png;base64,AA",
      }),
    ).toBeNull();
  });

  it("names the file when the payload is over the wire bound", () => {
    const dataUrl = `data:image/png;base64,${"A".repeat(ISSUE_COMMENT_ATTACHMENT_MAX_DATA_URL_CHARS)}`;
    expect(issueCommentAttachmentDataUrlRejection({ name: "shot.png", dataUrl })).toBe(
      issueCommentAttachmentTooLargeMessage("shot.png"),
    );
  });

  it("falls back to a generic subject for an unnamed paste", () => {
    expect(issueCommentAttachmentTooLargeMessage("  ")).toMatch(/^That image is larger than /);
  });
});

describe("issueCommentAttachmentIds", () => {
  it("collects uploaded ids in composer order and ignores uploads in flight", () => {
    expect(issueCommentAttachmentIds([uploaded("a"), uploading("b"), uploaded("c")])).toEqual([
      "iss_a",
      "iss_c",
    ]);
  });
});

describe("issue attachment shelf", () => {
  const comment = (id: string, attachmentIds: ReadonlyArray<ChatAttachmentId>): IssueComment => ({
    id: IssueCommentId.make(id),
    issueId: IssueId.make("issue-1"),
    author: { kind: "user" },
    body: "Images",
    attachmentIds,
    createdAt: "2026-08-13T00:00:00.000Z",
    editedAt: null,
  });

  it("collects unique images across comments in activity order", () => {
    const first = ChatAttachmentId.make("iss_first");
    const second = ChatAttachmentId.make("iss_second");
    expect(issueAttachmentIds([comment("c1", [first]), comment("c2", [first, second])])).toEqual([
      first,
      second,
    ]);
  });

  it("keeps the owning comment for each removable image", () => {
    const first = ChatAttachmentId.make("iss_first");
    const second = ChatAttachmentId.make("iss_second");
    expect(
      issueAttachmentReferences([comment("c1", [first]), comment("c2", [first, second])]),
    ).toEqual([
      { attachmentId: first, commentId: "c1" },
      { attachmentId: second, commentId: "c2" },
    ]);
  });

  it("describes shelf uploads in singular and plural", () => {
    expect(issueAttachmentComment(1)).toBe("Added an image to this issue.");
    expect(issueAttachmentComment(3)).toBe("Added 3 images to this issue.");
  });
});

describe("issueCommentComposerState", () => {
  it("hides the action row until there is something to post or discard", () => {
    const state = issueCommentComposerState({ draft: "  ", attachments: [] });
    expect(state.showActions).toBe(false);
    expect(state.canSubmit).toBe(false);
    expect(state.hint).toBeNull();
  });

  it("posts a trimmed body", () => {
    const state = issueCommentComposerState({ draft: "  ship it\n", attachments: [] });
    expect(state.body).toBe("ship it");
    expect(state.canSubmit).toBe(true);
  });

  it("asks for a message when only images are staged", () => {
    const state = issueCommentComposerState({ draft: "", attachments: [uploaded("a")] });
    expect(state.showActions).toBe(true);
    expect(state.canSubmit).toBe(false);
    expect(state.hint).toBe("Add a message to post these images.");
  });

  it("blocks the post while an upload is still running", () => {
    const state = issueCommentComposerState({
      draft: "look",
      attachments: [uploaded("a"), uploading("b")],
    });
    expect(state.isUploading).toBe(true);
    expect(state.canSubmit).toBe(false);
    expect(state.hint).toBe("Waiting for the image to finish uploading…");
  });
});
