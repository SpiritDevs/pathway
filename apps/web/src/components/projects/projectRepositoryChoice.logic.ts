import { derivePhysicalProjectKeyFromPath } from "~/logicalProject";
import type { ClientSettings } from "@spiritdevs/contracts/settings";
import type { EnvironmentId, RepositoryIdentity } from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";

export type ProjectRepositoryChoice =
  | { readonly kind: "existing"; readonly projectKey: string }
  | { readonly kind: "new" };

export interface ProjectBindingTarget {
  readonly companyId: CompanyId;
  readonly cloudProjectId: string | null;
}

/**
 * Resolve ownership before opening a newly-created project.
 *
 * Repository choices are authoritative. Without one, a sole available workspace is the only
 * possible answer and can be applied immediately; multiple workspaces deliberately return null so
 * the global ownership dialog asks the user instead of guessing.
 */
export function resolveCreatedProjectBindingTarget(input: {
  readonly choice: ProjectRepositoryChoice | null;
  readonly existingTarget: ProjectBindingTarget | null;
  readonly activeCompanyId: CompanyId | null;
  readonly availableCompanyIds: ReadonlyArray<CompanyId>;
}): ProjectBindingTarget | null {
  if (input.choice?.kind === "existing") return input.existingTarget;
  if (input.choice?.kind === "new") {
    return input.activeCompanyId === null
      ? null
      : { companyId: input.activeCompanyId, cloudProjectId: null };
  }
  return input.availableCompanyIds.length === 1
    ? { companyId: input.availableCompanyIds[0]!, cloudProjectId: null }
    : null;
}

export function findProjectsForRepository<
  TGroup extends {
    readonly memberProjects: ReadonlyArray<{
      readonly repositoryIdentity?: RepositoryIdentity | null | undefined;
    }>;
  },
>(
  groups: ReadonlyArray<TGroup>,
  repositoryIdentity: RepositoryIdentity | null,
): ReadonlyArray<TGroup> {
  if (repositoryIdentity === null) return [];
  return groups.filter((group) =>
    group.memberProjects.some(
      (member) => member.repositoryIdentity?.canonicalKey === repositoryIdentity.canonicalKey,
    ),
  );
}

/**
 * Persists the decision against the physical checkout rather than the repository. That is what
 * lets two directories for one Git remote remain two projects, while a connection can still join
 * one specifically even when several projects point at that remote.
 */
export function projectRepositoryChoiceSettings(input: {
  readonly settings: Pick<
    ClientSettings,
    "sidebarProjectGroupAssignments" | "sidebarProjectGroupingOverrides"
  >;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
  readonly choice: ProjectRepositoryChoice;
}) {
  const physicalKey = derivePhysicalProjectKeyFromPath(input.environmentId, input.workspaceRoot);
  const sidebarProjectGroupAssignments = {
    ...input.settings.sidebarProjectGroupAssignments,
  };
  const sidebarProjectGroupingOverrides = {
    ...input.settings.sidebarProjectGroupingOverrides,
  };

  if (input.choice.kind === "existing") {
    sidebarProjectGroupAssignments[physicalKey] = input.choice.projectKey;
    delete sidebarProjectGroupingOverrides[physicalKey];
  } else {
    // A self-assignment is both a stable independent group and a durable marker for the later
    // company-assignment step, which must not infer an existing cloud project from the Git remote.
    sidebarProjectGroupAssignments[physicalKey] = physicalKey;
    delete sidebarProjectGroupingOverrides[physicalKey];
  }

  return { sidebarProjectGroupAssignments, sidebarProjectGroupingOverrides };
}
