import { ISSUE_COMMENT_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isNewIssueAttachmentRecord,
  newIssueAttachmentComment,
  newIssueAttachmentDataUrlRejection,
  newIssueAttachmentIntake,
} from "./newIssueAttachments";

const image = (name: string) => ({ name, type: "image/png" });

describe("new issue attachments", () => {
  it("takes images, skips other files, and preserves their order", () => {
    const result = newIssueAttachmentIntake({
      files: [image("first"), { name: "notes", type: "text/plain" }, image("second")],
      currentCount: 0,
    });

    expect(result.accepted.map((file) => file.name)).toStrictEqual(["first", "second"]);
    expect(result.rejection).toBe(
      "Only images can be attached to an issue, so 1 file was skipped.",
    );
  });

  it("cuts a gesture to the remaining attachment slots", () => {
    const result = newIssueAttachmentIntake({
      files: [image("first"), image("second")],
      currentCount: ISSUE_COMMENT_MAX_ATTACHMENTS - 1,
    });

    expect(result.accepted.map((file) => file.name)).toStrictEqual(["first"]);
    expect(result.rejection).toContain("1 was not attached");
  });

  it("rejects an encoded image that cannot fit the wire contract", () => {
    expect(
      newIssueAttachmentDataUrlRejection({ name: "large.png", dataUrl: "x".repeat(20_000_000) }),
    ).toContain("large.png is larger");
  });

  it("describes the attachment metadata in singular and plural", () => {
    expect(newIssueAttachmentComment(1)).toContain("Attached an image when creating this issue.");
    expect(newIssueAttachmentComment(2)).toContain("Attached 2 images when creating this issue.");
  });

  it("identifies only the generated creation-time attachment record", () => {
    expect(
      isNewIssueAttachmentRecord({
        body: newIssueAttachmentComment(1),
        attachmentIds: ["iss_first"],
      }),
    ).toBe(true);
    expect(
      isNewIssueAttachmentRecord({
        body: newIssueAttachmentComment(1),
        attachmentIds: ["iss_first", "iss_second"],
      }),
    ).toBe(false);
    expect(
      isNewIssueAttachmentRecord({
        body: newIssueAttachmentComment(1),
        attachmentIds: [],
      }),
    ).toBe(false);
    expect(
      isNewIssueAttachmentRecord({
        body: "Attached an image when creating this issue.",
        attachmentIds: ["iss_first"],
      }),
    ).toBe(false);
  });
});
