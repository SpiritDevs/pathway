// The approval buttons claim one response per attempt. The component runs for
// real with its claim ref held across renders; buttons are pressed through the
// rendered element tree.

import { RuntimeRequestId } from "@spiritdevs/contracts";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { PendingApproval } from "../../session-logic";

const claim = vi.hoisted(() => ({ current: null as string | null }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: () => claim,
}));

const { ComposerPendingApprovalActions } = await import("./ComposerPendingApprovalActions");

type Props = Parameters<typeof ComposerPendingApprovalActions>[0];
const render = (
  ComposerPendingApprovalActions as unknown as { type: (props: Props) => ReactElement }
).type;

function approval(responseAttemptKey: string): PendingApproval {
  return {
    requestId: RuntimeRequestId.make("request-1"),
    requestKind: "command",
    createdAt: "2026-09-24T00:00:00.000Z",
    detail: "Allow command?",
    responseCapability: "live",
    responseAttemptKey,
  };
}

/** Presses Approve once on a fresh render and waits for the claim to settle. */
async function approve(
  pending: PendingApproval,
  onRespondToApproval: ReturnType<typeof vi.fn<Props["onRespondToApproval"]>>,
) {
  const tree = render({
    approval: pending,
    isResponding: false,
    canRespond: true,
    onRespondToApproval,
  });
  const children = (tree.props as { children: ReadonlyArray<ReactElement | null> }).children;
  const button = children.find((child) => child?.key === "accept");
  const calls = onRespondToApproval.mock.results.length;
  (button?.props as { onClick: () => void }).onClick();
  // The claim's `.then` was chained first, so it has run once this resumes.
  if (onRespondToApproval.mock.results.length > calls) {
    await onRespondToApproval.mock.results.at(-1)?.value;
  }
}

afterEach(() => {
  claim.current = null;
});

describe("ComposerPendingApprovalActions", () => {
  it("allows one new submission when the request is re-posted to a new session", async () => {
    const onRespondToApproval = vi.fn<Props["onRespondToApproval"]>(async () => ({
      _tag: "Success",
    }));
    await approve(approval("session-1"), onRespondToApproval);
    await approve(approval("session-1"), onRespondToApproval);
    expect(onRespondToApproval).toHaveBeenCalledTimes(1);

    await approve(approval("session-2"), onRespondToApproval);
    await approve(approval("session-2"), onRespondToApproval);
    expect(onRespondToApproval).toHaveBeenCalledTimes(2);
  });

  it("lets Approve go out once storage allows it after a local refusal", async () => {
    let storageAvailable = false;
    // ChatView's callback returns nothing when conversation storage refuses.
    const onRespondToApproval = vi.fn<Props["onRespondToApproval"]>(async () =>
      storageAvailable ? { _tag: "Success" } : undefined,
    );
    await approve(approval("session-1"), onRespondToApproval);
    storageAvailable = true;
    await approve(approval("session-1"), onRespondToApproval);
    expect(onRespondToApproval).toHaveBeenCalledTimes(2);
    expect(claim.current).not.toBeNull();
  });
});
