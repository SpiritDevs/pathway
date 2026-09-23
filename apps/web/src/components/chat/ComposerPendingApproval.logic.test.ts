import { describe, expect, it, vi } from "vite-plus/test";

import {
  APPROVAL_ACTIONS,
  approvalShortcutAction,
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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

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
  it("submits once while a response is pending, whether by click or shortcut", () => {
    const claim = { current: null as string | null };
    const respond = vi.fn(() => new Promise<unknown>(() => undefined));

    expect(respondToApprovalOnce({ claim, requestKey: "r1", isResponding: false, respond })).toBe(
      true,
    );
    expect(respondToApprovalOnce({ claim, requestKey: "r1", isResponding: false, respond })).toBe(
      false,
    );
    expect(respond).toHaveBeenCalledTimes(1);
  });

  it("does nothing while the request is already responding", () => {
    const claim = { current: null as string | null };
    const respond = vi.fn(async () => undefined);
    expect(respondToApprovalOnce({ claim, requestKey: "r1", isResponding: true, respond })).toBe(
      false,
    );
    expect(respond).not.toHaveBeenCalled();
  });

  it("allows a retry after a rejection or a failed command", async () => {
    const claim = { current: null as string | null };
    const rejected = vi.fn(async () => {
      throw new Error("offline");
    });
    respondToApprovalOnce({ claim, requestKey: "r1", isResponding: false, respond: rejected });
    await flush();
    expect(claim.current).toBeNull();

    const failed = vi.fn(async () => ({ _tag: "Failure" }));
    respondToApprovalOnce({ claim, requestKey: "r1", isResponding: false, respond: failed });
    await flush();
    expect(claim.current).toBeNull();
  });

  it("keeps the claim after a successful send, and lets a new request submit", async () => {
    const claim = { current: null as string | null };
    const respond = vi.fn(async () => ({ _tag: "Success" }));
    respondToApprovalOnce({ claim, requestKey: "r1", isResponding: false, respond });
    await flush();
    expect(respondToApprovalOnce({ claim, requestKey: "r1", isResponding: false, respond })).toBe(
      false,
    );
    expect(respondToApprovalOnce({ claim, requestKey: "r2", isResponding: false, respond })).toBe(
      true,
    );
    expect(respond).toHaveBeenCalledTimes(2);
  });
});
