import { createEnvironmentProjectAtoms } from "@spiritdevs/client-runtime/state/projects";
import { createProjectEnvironmentAtoms } from "@spiritdevs/client-runtime/state/projects";
import { createEnvironmentRpcQueryAtomFamily } from "@spiritdevs/client-runtime/state/runtime";
import { WS_METHODS, type EnvironmentId } from "@spiritdevs/contracts";
import { Atom } from "effect/unstable/reactivity";

import { activeCompanyIdAtom, scopedCompanyRegistryReplicasAtom } from "../cloud/activeCompany";
import {
  cloudEnvironmentProjectsAtom,
  companyScopedEnvironmentProjects,
} from "../cloud/agentThreadReadModel";
import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

const companyScopedProjectSnapshotAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const snapshot = get(environmentSnapshotAtom(environmentId));
    if (snapshot === null) return null;
    const projects = companyScopedEnvironmentProjects(
      snapshot.projects,
      get(activeCompanyIdAtom),
      get(scopedCompanyRegistryReplicasAtom),
      environmentId,
    );
    return projects === snapshot.projects ? snapshot : { ...snapshot, projects };
  }).pipe(Atom.withLabel(`company-scoped-project-snapshot:${environmentId}`)),
);

export const projectEnvironment = createProjectEnvironmentAtoms(connectionAtomRuntime);
/**
 * Web-only: project content search backs the ⇧⌘F dialog, which has no mobile
 * surface, so the atom family lives here instead of the shared client-runtime
 * project atoms consumed by the mobile app.
 */
export const projectContentSearch = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:projects:search-contents",
  tag: WS_METHODS.projectsSearchContents,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});
export const environmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: companyScopedProjectSnapshotAtom,
  fallbackProjectsAtom: cloudEnvironmentProjectsAtom,
});

/**
 * Local projects before the active-company filter is applied.
 *
 * The ownership gate needs this view so a newly-created checkout can be assigned to a company.
 * Feeding that gate from `environmentProjects` creates a deadlock: an unbound project is filtered
 * out before the gate can see it and create the missing binding.
 */
export const unscopedEnvironmentProjects = createEnvironmentProjectAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: environmentSnapshotAtom,
});
