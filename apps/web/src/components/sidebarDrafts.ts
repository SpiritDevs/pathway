import { scopedThreadKey, scopeThreadRef } from "@spiritdevs/client-runtime/environment";
import { threadIsVisibleAt } from "@spiritdevs/contracts";
import {
  composerDraftHasUserContent,
  DraftId,
  type ComposerThreadDraftState,
  type DraftSessionState,
} from "../composerDraftStore";

export interface SidebarDraftRowData {
  draftId: DraftId;
  session: DraftSessionState;
  composer: ComposerThreadDraftState | undefined;
}

/** Keep a sent draft reachable until its canonical row arrives, including after navigation. */
export function selectSidebarDraftRows(input: {
  draftThreadsByThreadKey: Readonly<Record<string, DraftSessionState>>;
  draftsByThreadKey: Readonly<Record<string, ComposerThreadDraftState>>;
  serverThreadKeys: ReadonlySet<string>;
  routeDraftId: string | null;
  scopedProjectKeys: ReadonlySet<string> | null;
  frozenActive: { routeDraftId: string | null; row: SidebarDraftRowData | null };
}): SidebarDraftRowData[] {
  const rows: SidebarDraftRowData[] = [];
  for (const [draftKey, session] of Object.entries(input.draftThreadsByThreadKey)) {
    if (
      session.promotedTo != null ||
      input.serverThreadKeys.has(
        scopedThreadKey(scopeThreadRef(session.environmentId, session.threadId)),
      ) ||
      !threadIsVisibleAt(session, "agents") ||
      (input.scopedProjectKeys !== null &&
        !input.scopedProjectKeys.has(`${session.environmentId}:${session.projectId}`))
    ) {
      continue;
    }
    const composer = input.draftsByThreadKey[draftKey];
    if (session.pendingSend) {
      rows.push({ draftId: DraftId.make(draftKey), session, composer });
    } else if (draftKey === input.routeDraftId) {
      if (input.frozenActive.routeDraftId === draftKey && input.frozenActive.row !== null) {
        rows.push({ ...input.frozenActive.row, session });
      }
    } else if (composerDraftHasUserContent(composer)) {
      rows.push({ draftId: DraftId.make(draftKey), session, composer });
    }
  }
  return rows.sort((left, right) =>
    (right.session.pendingSend?.createdAt ?? right.session.createdAt).localeCompare(
      left.session.pendingSend?.createdAt ?? left.session.createdAt,
    ),
  );
}
