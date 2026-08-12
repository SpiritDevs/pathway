/**
 * The second half of Start work: writing the thread↔issue link once the thread is real.
 *
 * `useNewThreadHandler` hands back a thread id it minted itself, and the server only materialises
 * that id when the composer is finally sent. Linking at the press would therefore record a thread
 * for every draft anybody opened and walked away from — the server does not check that a thread
 * exists, because a link is a fact about intent rather than a foreign key.
 *
 * So the press parks the issue id against the draft (session storage, cleared on read) and this
 * hook — mounted by the draft route, which is the one place that sees a draft become a thread —
 * spends it. A draft that is never sent leaves an entry that expires with the tab.
 *
 * @module components/issues/useIssueStartWorkLink
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";

import { useLinkIssueThread } from "~/state/issues";
import { takePendingIssueThreadLink } from "./issueStartWork.logic";
import { reportIssueWriteFailure } from "./issueWriteFeedback";

export function useIssueStartWorkLink(input: {
  readonly draftId: string;
  /** The environment the draft belongs to; the tracker only exists on the primary one. */
  readonly environmentId: EnvironmentId | null;
  /** Non-null once the server has a thread carrying the draft's id. */
  readonly threadId: ThreadId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): void {
  const linkThread = useLinkIssueThread();
  const { draftId, environmentId, threadId, primaryEnvironmentId } = input;

  useEffect(() => {
    if (threadId === null) return;
    // A draft on another machine's server has no tracker to link into, and the pending entry is
    // left alone rather than dropped: it is keyed by draft, and drafts do not change environment.
    if (environmentId === null || environmentId !== primaryEnvironmentId) return;
    const issueId = takePendingIssueThreadLink(window.sessionStorage, draftId);
    if (issueId === null) return;
    void (async () => {
      reportIssueWriteFailure(
        "Failed to link the thread to its issue",
        await linkThread({ issueId, threadId, origin: "start-work" }),
      );
    })();
  }, [draftId, environmentId, linkThread, primaryEnvironmentId, threadId]);
}
