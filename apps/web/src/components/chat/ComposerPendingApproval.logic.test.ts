import { describe, expect, it, vi } from "vite-plus/test";

import {
  APPROVAL_ACTIONS,
  approvalShortcutAction,
  approvalSubmissionKey,
  resolveApprovalActions,
  respondToApprovalOnce,
} from "./ComposerPendingApproval.logic";

const key = (
  value: string,
  overrides: Partial<Parameters<typeof approvalShortcutAction>[0]> = {},
) => ({
  key: value,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  targetIsEditable: false,
  ...overrides,
});

describe("resolveApprovalActions", () => {
  it("keeps Synara's four actions and their order for non-Computer approvals", () => {
    expect(resolveApprovalActions(null).map((action) => [action.decision, action.label])).toEqual([
      ["accept", "Approve once"],
      ["acceptForSession", "Always allow this session"],
      ["decline", "Decline"],
      ["cancel", "Cancel turn"],
    ]);
  });

  it("relabels task consent and drops the session-wide approval", () => {
    expect(resolveApprovalActions({ scope: "task" })).toEqual([
      {
        decision: "accept",
        label: "Allow Computer for this task",
        description:
          "Continue routine desktop actions until this response ends. Stop cancels access. Clipboard reads still ask separately.",
      },
      {
        decision: "decline",
        label: "Decline",
        description: "Stop desktop for this turn, agent continues without tools",
      },
      {
        decision: "cancel",
        label: "Cancel turn",
        description: "Stop revokes new input; keys/buttons already sent may still land.",
      },
    ]);
  });

  it("offers a supervised call the default copy without the session-wide approval", () => {
    expect(
      resolveApprovalActions({ scope: "call", toolName: "computer_click", args: undefined }),
    ).toEqual(APPROVAL_ACTIONS.filter((action) => action.decision !== "acceptForSession"));
  });
});

describe("approvalShortcutAction", () => {
  const actions = resolveApprovalActions(null);

  it("maps digits to actions in order", () => {
    expect(approvalShortcutAction(key("1"), actions)?.decision).toBe("accept");
    expect(approvalShortcutAction(key("2"), actions)?.decision).toBe("acceptForSession");
    expect(approvalShortcutAction(key("3"), actions)?.decision).toBe("decline");
    expect(approvalShortcutAction(key("4"), actions)?.decision).toBe("cancel");
    expect(approvalShortcutAction(key("5"), actions)).toBeNull();
    expect(approvalShortcutAction(key("0"), actions)).toBeNull();
  });

  it("ignores modified keys and keys typed into a text field", () => {
    expect(approvalShortcutAction(key("1", { metaKey: true }), actions)).toBeNull();
    expect(approvalShortcutAction(key("1", { ctrlKey: true }), actions)).toBeNull();
    expect(approvalShortcutAction(key("1", { altKey: true }), actions)).toBeNull();
    expect(approvalShortcutAction(key("1", { targetIsEditable: true }), actions)).toBeNull();
  });

  it("follows the shortened list on a Computer task card", () => {
    const task = resolveApprovalActions({ scope: "task" });
    expect(approvalShortcutAction(key("3"), task)?.decision).toBe("cancel");
    expect(approvalShortcutAction(key("4"), task)).toBeNull();
  });
});

describe("respondToApprovalOnce", () => {
  const claimFor = () => ({ current: null as string | null });

  it("submits once while a response is pending, whether by click or shortcut", () => {
    const claim = claimFor();
    const respond = vi.fn(() => new Promise<unknown>(() => undefined));

    expect(
      respondToApprovalOnce({ claim, requestKey: "r1", isResponding: false, respond }),
    ).not.toBeNull();
    expect(respondToApprovalOnce({ claim, requestKey: "r1", isResponding: false, respond })).toBe(
      null,
    );
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("does nothing while the request is already responding", () => {
    const respond = vi.fn(async () => undefined);
    expect(
      respondToApprovalOnce({ claim: claimFor(), requestKey: "r1", isResponding: true, respond }),
    ).toBeNull();
    expect(respond).not.toHaveBeenCalled();
  });

  it("allows a retry after a rejection or a failed command", async () => {
    const claim = claimFor();
    const rejected = vi.fn(async () => {
      throw new Error("offline");
    });
    await respondToApprovalOnce({
      claim,
      requestKey: "r1",
      isResponding: false,
      respond: rejected,
    });
    expect(claim.current).toBeNull();

    const failed = vi.fn(async () => ({ _tag: "Failure" }));
    await respondToApprovalOnce({ claim, requestKey: "r1", isResponding: false, respond: failed });
    expect(claim.current).toBeNull();
  });

  it("releases a claim a local guard refused without sending, so Cancel still works", async () => {
    const claim = claimFor();
    // Conversation storage refused Approve before any command went out.
    const refused = vi.fn(async () => undefined);
    await respondToApprovalOnce({ claim, requestKey: "r1", isResponding: false, respond: refused });
    expect(claim.current).toBeNull();

    const cancel = vi.fn(async () => ({ _tag: "Success" }));
    await respondToApprovalOnce({ claim, requestKey: "r1", isResponding: false, respond: cancel });
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("keeps the claim after a successful send, and lets a new request submit", async () => {
    const claim = claimFor();
    const respond = vi.fn(async () => ({ _tag: "Success" }));
    await respondToApprovalOnce({ claim, requestKey: "r1", isResponding: false, respond });
    expect(respondToApprovalOnce({ claim, requestKey: "r1", isResponding: false, respond })).toBe(
      null,
    );
    expect(
      respondToApprovalOnce({ claim, requestKey: "r2", isResponding: false, respond }),
    ).not.toBeNull();
    expect(respond).toHaveBeenCalledTimes(2);
  });

  it("allows one new submission when a newer live attempt becomes answerable", async () => {
    const claim = claimFor();
    const respond = vi.fn(async () => ({ _tag: "Success" }));
    const first = approvalSubmissionKey({ requestId: "r1", responseAttemptKey: "session-1" });
    await respondToApprovalOnce({ claim, requestKey: first, isResponding: false, respond });
    expect(respondToApprovalOnce({ claim, requestKey: first, isResponding: false, respond })).toBe(
      null,
    );

    // The same request, re-posted to a new provider session.
    const second = approvalSubmissionKey({ requestId: "r1", responseAttemptKey: "session-2" });
    await respondToApprovalOnce({ claim, requestKey: second, isResponding: false, respond });
    expect(respondToApprovalOnce({ claim, requestKey: second, isResponding: false, respond })).toBe(
      null,
    );
    expect(respond).toHaveBeenCalledTimes(2);
  });
});
