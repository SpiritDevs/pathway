import type { ProjectIcon } from "@spiritdevs/contracts/cloudProject";
import { Atom } from "effect/unstable/reactivity";

import { cloudProjectsAtom, environmentBindingsAtom } from "../cloud/issueDomainReadModel";

/** The icon a company project shows on every device, chosen once and synced through the cloud. */
export type SyncedProjectIcon =
  | { readonly _tag: "Library"; readonly icon: ProjectIcon }
  | { readonly _tag: "Image"; readonly url: string };

export function projectIconCheckoutKey(environmentId: string, workspaceRoot: string): string {
  return `${environmentId}\u0000${workspaceRoot}`;
}

const EMPTY_ICONS: ReadonlyMap<string, SyncedProjectIcon> = new Map();

/** Synced icons chosen for company projects, keyed by every live checkout bound to them. */
const projectIconsByCheckoutAtom = Atom.make((get): ReadonlyMap<string, SyncedProjectIcon> => {
  const iconByProjectId = new Map<string, SyncedProjectIcon>();
  for (const project of get(cloudProjectsAtom)) {
    if (project.iconImageUrl) {
      iconByProjectId.set(project.id, { _tag: "Image", url: project.iconImageUrl });
    } else if (project.icon) {
      iconByProjectId.set(project.id, { _tag: "Library", icon: project.icon });
    }
  }
  if (iconByProjectId.size === 0) return EMPTY_ICONS;
  const icons = new Map<string, SyncedProjectIcon>();
  for (const binding of get(environmentBindingsAtom)) {
    const icon = iconByProjectId.get(binding.cloudProjectId);
    if (icon !== undefined && binding.status !== "revoked") {
      icons.set(projectIconCheckoutKey(binding.environmentId, binding.localWorkspaceRoot), icon);
    }
  }
  return icons;
}).pipe(Atom.withLabel("cloud-sync:project-icons"));

/** One subscription per checkout so a change re-renders only the rows it affects. */
export const projectIconAtom = Atom.family((checkoutKey: string) =>
  Atom.make((get) => get(projectIconsByCheckoutAtom).get(checkoutKey) ?? null),
);
