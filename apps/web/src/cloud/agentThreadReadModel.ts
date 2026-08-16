/** Cloud discovery fallbacks for Agent Thread projects and thread shells. */
import {
  AgentThreadEntity,
  CloudProjectSyncEntity,
  EnvironmentBindingEntity,
} from "@spiritdevs/client-runtime/sync";
import type {
  EnvironmentId,
  OrchestrationProjectShell,
  OrchestrationV2ThreadShell,
} from "@spiritdevs/contracts";
import * as Schema from "effect/Schema";
import { Atom } from "effect/unstable/reactivity";

import { companyRegistryReplicasAtom } from "./companyRegistryReplica";

const EMPTY_PROJECTS: ReadonlyArray<OrchestrationProjectShell> = Object.freeze([]);
const EMPTY_THREADS: ReadonlyArray<OrchestrationV2ThreadShell> = Object.freeze([]);
const isCloudProject = Schema.is(CloudProjectSyncEntity);
const isEnvironmentBinding = Schema.is(EnvironmentBindingEntity);
const isAgentThread = Schema.is(AgentThreadEntity);

function iso(timestamp: number): string {
  return new Date(timestamp).toISOString();
}

export const cloudEnvironmentProjectsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<OrchestrationProjectShell> => {
    const projects: OrchestrationProjectShell[] = [];
    const seen = new Set<string>();
    for (const replica of get(companyRegistryReplicasAtom).values()) {
      const cloudProjects = new Map(
        [...replica.view.values()]
          .filter(isCloudProject)
          .map((project) => [project.id, project] as const),
      );
      for (const value of replica.view.values()) {
        if (
          !isEnvironmentBinding(value) ||
          value.environmentId !== environmentId ||
          value.status !== "active" ||
          seen.has(value.localProjectId)
        ) {
          continue;
        }
        const project = cloudProjects.get(value.cloudProjectId);
        if (project === undefined || project.archivedAt !== null) continue;
        seen.add(value.localProjectId);
        projects.push({
          id: value.localProjectId,
          title: project.name,
          workspaceRoot: value.localWorkspaceRoot,
          defaultModelSelection: null,
          scripts: [],
          createdAt: iso(project.createdAt),
          updatedAt: iso(Math.max(project.updatedAt, value.updatedAt)),
        });
      }
    }
    return projects.length === 0 ? EMPTY_PROJECTS : projects;
  }).pipe(Atom.withLabel(`cloud-agent-projects:${environmentId}`)),
);

/**
 * Restores the ordinary shell shape for list presentation. The placeholder message text is never
 * rendered as transcript content; opening the thread replaces this fallback from its relay.
 */
export const cloudEnvironmentThreadsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<OrchestrationV2ThreadShell> => {
    const threads: OrchestrationV2ThreadShell[] = [];
    const seen = new Set<string>();
    for (const replica of get(companyRegistryReplicasAtom).values()) {
      for (const value of replica.view.values()) {
        if (
          !isAgentThread(value) ||
          value.environmentId !== environmentId ||
          value.shell.archivedAt !== null ||
          value.shell.deletedAt !== null ||
          seen.has(value.shell.id)
        ) {
          continue;
        }
        seen.add(value.shell.id);
        threads.push({
          ...value.shell,
          latestVisibleMessage:
            value.shell.latestVisibleMessage === null
              ? null
              : { ...value.shell.latestVisibleMessage, text: "" },
        });
      }
    }
    return threads.length === 0 ? EMPTY_THREADS : threads;
  }).pipe(Atom.withLabel(`cloud-agent-threads:${environmentId}`)),
);
