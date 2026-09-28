/**
 * Removal steps shared by every place that deletes a project: project settings and the Tasks
 * sidebar. Confirmation and navigation stay with the caller; this is what happens after "yes".
 *
 * @module components/projects/projectRemoval
 */
import { scopeProjectRef, scopeThreadRef } from "@spiritdevs/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";

import type { EnvironmentControlClient } from "../../cloud/environmentControl";
import { useComposerDraftStore } from "../../composerDraftStore";
import { releaseProjectDraftUploads } from "../../lib/composerDraftUploads";

/** What one "remove this project everywhere" attempt actually accomplished. */
export interface CompanyProjectRemoval {
  /** How many owning workspaces reported that they removed a live project. */
  readonly removed: number;
  /** One message per workspace whose delete threw, in the order they were asked. */
  readonly failures: ReadonlyArray<string>;
}

/**
 * Deletes one cloud project from every workspace listed as an owner.
 *
 * Two rules matter here, and both come from the same failure: a project that stayed on screen
 * after the user removed it.
 *
 * Every owner is asked even after one of them fails. Stopping at the first error is what leaves a
 * project deleted in the workspaces asked before it and alive in the ones after it — and the one
 * still holding it is the one that keeps rendering it in the list.
 *
 * The count of *actual* removals is what the caller reports on, not the absence of an exception. A
 * workspace that has no live project with this id answers `deleted: false` rather than throwing,
 * because asking the wrong owner is a normal part of this loop; treating that quiet answer as
 * success is what let the UI navigate away from a project it had not removed.
 */
export async function removeCompanyProjectFromOwners(input: {
  readonly environmentControl: EnvironmentControlClient;
  readonly companyIds: ReadonlyArray<CompanyId>;
  readonly cloudProjectId: string;
}): Promise<CompanyProjectRemoval> {
  let removed = 0;
  const failures: string[] = [];
  for (const companyId of input.companyIds) {
    try {
      const result = await input.environmentControl.deleteCompanyProject({
        companyId,
        cloudProjectId: input.cloudProjectId,
      });
      if (result.deleted) removed += 1;
    } catch (error) {
      failures.push(
        error instanceof Error ? error.message : "The cloud project could not be removed.",
      );
    }
  }
  return { removed, failures };
}

/** The message for a removal that finished without deleting the project the user was looking at. */
export function companyProjectRemovalFailure(removal: CompanyProjectRemoval): string | null {
  if (removal.failures.length > 0) return removal.failures[0]!;
  if (removal.removed === 0) {
    return "No workspace you can manage still owns this project. Reload to refresh the list.";
  }
  return null;
}

/** Drops composer drafts and their uploads for checkouts that no longer exist. */
export function clearRemovedProjectDrafts(
  members: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly id: ProjectId }>,
  threads: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId | null;
    readonly id: ThreadId;
  }>,
): void {
  const draftStore = useComposerDraftStore.getState();
  for (const member of members) {
    const projectRef = scopeProjectRef(member.environmentId, member.id);
    releaseProjectDraftUploads(
      projectRef,
      threads
        .filter(
          (thread) =>
            thread.environmentId === member.environmentId && thread.projectId === member.id,
        )
        .map((thread) => scopeThreadRef(thread.environmentId, thread.id)),
    );
    const projectDraftThread = draftStore.getDraftThreadByProjectRef(projectRef);
    if (projectDraftThread) {
      draftStore.clearDraftThread(projectDraftThread.draftId);
    }
    draftStore.clearProjectDraftThreadId(projectRef);
  }
}
