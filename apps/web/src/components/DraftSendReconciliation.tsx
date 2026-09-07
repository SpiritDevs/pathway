import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@spiritdevs/contracts";
import * as Option from "effect/Option";
import { useEffect, useMemo } from "react";
import { reconcilePendingDraftSends, useComposerDraftStore } from "../composerDraftStore";
import { environmentShell } from "../state/shell";

function EnvironmentDraftSendReconciliation(props: {
  environmentId: EnvironmentId;
  activeDraftId: string | null;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(props.environmentId));
  const drafts = useComposerDraftStore((state) => state.draftThreadsByThreadKey);
  useEffect(() => {
    // Cached or company-filtered lists cannot establish that a send was lost.
    if (shell.status !== "live" || Option.isNone(shell.snapshot)) return;
    const threads = [...shell.snapshot.value.threads, ...shell.snapshot.value.archivedThreads];
    reconcilePendingDraftSends({
      status: shell.status,
      environmentId: props.environmentId,
      activeDraftId: props.activeDraftId,
      acceptedThreadIds: new Set(
        threads.filter((thread) => thread.latestUserMessageAt !== null).map((thread) => thread.id),
      ),
    });
  }, [drafts, shell, props.environmentId, props.activeDraftId]);
  return null;
}

export function DraftSendReconciliation(props: { activeDraftId: string | null }) {
  const drafts = useComposerDraftStore((state) => state.draftThreadsByThreadKey);
  const environmentIds = useMemo(
    () => [
      ...new Set(
        Object.values(drafts)
          .filter((draft) => draft.pendingSend != null)
          .map((draft) => draft.environmentId),
      ),
    ],
    [drafts],
  );
  return environmentIds.map((environmentId) => (
    <EnvironmentDraftSendReconciliation
      key={environmentId}
      environmentId={environmentId}
      activeDraftId={props.activeDraftId}
    />
  ));
}
