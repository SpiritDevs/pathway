import { AuthPeerReadUnsupportedCode, ThreadId } from "@spiritdevs/contracts";
import { ConvexError } from "convex/values";
import { describe, expect, it } from "vite-plus/test";

import { grantFailureMessage } from "./remoteThreads.ts";

const threadId = ThreadId.make("thread-elsewhere");

describe("grantFailureMessage", () => {
  it("asks for an update when the thread's environment cannot limit remote reads", () => {
    expect(
      grantFailureMessage(
        threadId,
        new ConvexError({ code: AuthPeerReadUnsupportedCode, message: "update" }),
      ),
    ).toMatch(/older Pathway that cannot limit remote reads/u);
  });

  it("fails closed with a generic message for other refusals and older Pathway Cloud", () => {
    for (const cause of [
      new ConvexError({ code: "permission-denied", message: "no" }),
      new Error("Could not find public function for 'connectGrants:issueThreadAccess'"),
    ]) {
      expect(grantFailureMessage(threadId, cause)).toBe(
        `Pathway could not reach thread ${threadId} on its environment.`,
      );
    }
  });
});
