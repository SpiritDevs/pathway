import type { CompanyRegistryReplicaState } from "@spiritdevs/client-runtime/connection";
import {
  AgentThreadEntity,
  EnvironmentBindingEntity,
  EnvironmentRegistrationEntity,
} from "@spiritdevs/client-runtime/sync";
import {
  isPathwayEnvironmentDescriptor,
  type EnvironmentId,
  type StorageSnapshot,
} from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { normalizeProjectPathForComparison } from "@spiritdevs/shared/path";
import * as Schema from "effect/Schema";

const isAgentThread = Schema.is(AgentThreadEntity);
const isBinding = Schema.is(EnvironmentBindingEntity);
const isRegistration = Schema.is(EnvironmentRegistrationEntity);

/** Capacity is machine-wide; thread details follow the same company selection as conversations. */
export function companyScopedStorageSnapshot(
  snapshot: StorageSnapshot,
  companyId: CompanyId | null,
  replicas: ReadonlyMap<CompanyId, CompanyRegistryReplicaState>,
  environmentId: EnvironmentId,
): StorageSnapshot {
  const allowedThreads = new Set<string>();
  const registeredCompanies = new Set<string>();
  const projectRoots = new Set<string>();
  const caseInsensitiveProjectRoots = new Set<string>();
  for (const [replicaCompanyId, replica] of replicas) {
    if (companyId !== null && companyId !== replicaCompanyId) continue;
    const registration = [...replica.view.values()].find(
      (value) =>
        isRegistration(value) &&
        value.environmentId === environmentId &&
        value.state === "active" &&
        isPathwayEnvironmentDescriptor(value.descriptor),
    );
    if (!registration || !isRegistration(registration)) continue;
    registeredCompanies.add(replicaCompanyId);
    const caseInsensitive =
      registration.descriptor.platform.os === "darwin" ||
      registration.descriptor.platform.os === "windows";
    for (const value of replica.view.values()) {
      if (isAgentThread(value) && value.environmentId === environmentId) {
        if (
          value.shell.projectId !== null ||
          value.shell.conversationCompanyId === replicaCompanyId
        )
          allowedThreads.add(value.shell.id);
      }
      if (isBinding(value) && value.environmentId === environmentId && value.status === "active") {
        const root = normalizeProjectPathForComparison(value.localWorkspaceRoot);
        if (caseInsensitive) caseInsensitiveProjectRoots.add(root.toLowerCase());
        else projectRoots.add(root);
      }
    }
  }
  const projectRootIsVisible = (path: string | null | undefined) => {
    if (!path) return false;
    const root = normalizeProjectPathForComparison(path);
    return projectRoots.has(root) || caseInsensitiveProjectRoots.has(root.toLowerCase());
  };
  const threads = snapshot.threads.filter((thread) => {
    if (thread.projectId !== null) return companyId === null || allowedThreads.has(thread.threadId);
    const owner = "conversationCompanyId" in thread ? thread.conversationCompanyId : null;
    return typeof owner === "string"
      ? registeredCompanies.has(owner)
      : allowedThreads.has(thread.threadId);
  });
  const threadIds = new Set(threads.map((thread) => thread.threadId));
  const worktrees = snapshot.worktrees.filter((worktree) => {
    if (worktree.kind !== "orphan") return worktree.threadIds.some((id) => threadIds.has(id));
    if (companyId === null) return true;
    return projectRootIsVisible(worktree.projectRoot);
  });
  const worktreeIds = new Set(worktrees.map((worktree) => worktree.id));
  return {
    ...snapshot,
    threads,
    worktrees,
    jobs:
      companyId === null
        ? snapshot.jobs
        : snapshot.jobs.flatMap((job) => {
            const items = job.items.filter(
              (item) => worktreeIds.has(item.worktreeId) || projectRootIsVisible(item.projectRoot),
            );
            return items.length ? [{ ...job, items }] : [];
          }),
  };
}
