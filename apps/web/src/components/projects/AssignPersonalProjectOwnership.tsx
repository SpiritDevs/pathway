/** Assign older, unowned checkouts to personal without blocking app startup. */
import { useAtomValue } from "@effect/atom-react";
import { scopedProjectKey, scopeProjectRef } from "@spiritdevs/client-runtime/environment";
import { useEffect, useRef } from "react";
import { companySyncStatusesAtom } from "~/cloud/syncStatus";
import { companyListAtom } from "~/cloud/activeCompany";
import { useEnvironmentControl } from "~/cloud/useEnvironmentControl";
import { toastManager } from "~/components/ui/toast";
import { useClientSettings } from "~/hooks/useSettings";
import { useUnscopedWorkspaceProjects } from "./useWorkspaceProjects";
import {
  projectAutomaticAssignmentTarget,
  usePendingProjectAutomaticAssignments,
} from "./projectAutomaticAssignmentState";
import {
  settleMissingWorkspaceProjectRemovals,
  usePendingWorkspaceProjectRemovals,
} from "./projectRemovalState";
import { unassignedWorkspaceProjects } from "./workspaceProjects.logic";

export function AssignPersonalProjectOwnership() {
  const projects = useUnscopedWorkspaceProjects();
  const companies = useAtomValue(companyListAtom);
  const control = useEnvironmentControl();
  const syncStatuses = useAtomValue(companySyncStatusesAtom);
  const groupAssignments = useClientSettings((settings) => settings.sidebarProjectGroupAssignments);
  const pendingRemovals = usePendingWorkspaceProjectRemovals();
  const pendingAssignments = usePendingProjectAutomaticAssignments();
  const attempted = useRef(new Set<string>());

  useEffect(() => {
    settleMissingWorkspaceProjectRemovals(new Set(projects.map((project) => project.projectKey)));
  }, [projects]);

  useEffect(() => {
    if (control === null || companies.length === 0 || syncStatuses.size === 0) return;
    if ([...syncStatuses.values()].some((status) => !status.bootstrapComplete)) return;
    const checkouts = unassignedWorkspaceProjects(projects)
      .filter((project) => !pendingRemovals.has(project.projectKey))
      .flatMap((project) => project.group?.memberProjects ?? [])
      .filter((checkout) => {
        const key = scopedProjectKey(scopeProjectRef(checkout.environmentId, checkout.id));
        return !pendingAssignments.has(key) && !attempted.current.has(key);
      });
    if (checkouts.length === 0) return;
    for (const checkout of checkouts) {
      attempted.current.add(scopedProjectKey(scopeProjectRef(checkout.environmentId, checkout.id)));
    }
    void (async () => {
      // Provisioning is idempotent and also handles accounts created inside an organization.
      const companyId =
        companies.find((company) => company.workspaceKind === "personal")?.id ??
        (await control.provisionPersonalWorkspace());
      for (const checkout of checkouts) {
        const target = projectAutomaticAssignmentTarget(
          scopedProjectKey(scopeProjectRef(checkout.environmentId, checkout.id)),
        );
        await control.ensureEnvironmentProject({
          companyId: target?.companyId ?? companyId,
          ...(target?.cloudProjectId != null ? { cloudProjectId: target.cloudProjectId } : {}),
          ...(target?.matchRepository === false ? { matchRepository: false } : {}),
          ...(groupAssignments[checkout.physicalProjectKey] === checkout.physicalProjectKey
            ? { matchRepository: false }
            : {}),
          project: checkout,
        });
      }
    })().catch((cause: unknown) => {
      toastManager.add({
        type: "error",
        title: "Could not assign projects to your personal workspace",
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
    });
  }, [
    companies,
    control,
    groupAssignments,
    pendingAssignments,
    pendingRemovals,
    projects,
    syncStatuses,
  ]);

  return null;
}
