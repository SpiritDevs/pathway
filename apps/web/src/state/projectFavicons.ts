import { Atom } from "effect/unstable/reactivity";

import { scopedCompanyRegistryReplicasAtom } from "../cloud/activeCompany";
import { buildProjectConnectionCatalog } from "../components/projects/projectConnectionMetadata";
import { environmentCatalog } from "../connection/catalog";
import { environmentProjects } from "./projects";
import { deriveProjectFaviconSources } from "./projectFaviconSources";

const projectFaviconSourcesAtom = Atom.make((get) => {
  const projects = get(environmentProjects.projectsAtom);
  const replicas = get(scopedCompanyRegistryReplicasAtom);
  const catalog = buildProjectConnectionCatalog(
    Array.from(replicas.values()).flatMap((replica) => Array.from(replica.view.values())),
  );
  const connectedEnvironmentIds = new Set(
    projects
      .map((project) => project.environmentId)
      .filter((id) => {
        const state = get(environmentCatalog.stateAtom(id));
        return state._tag === "Success" && state.value.phase === "connected";
      }),
  );
  return deriveProjectFaviconSources({ projects, ...catalog, connectedEnvironmentIds });
});

export const projectFaviconSourceAtom = Atom.family((key: string) =>
  Atom.make((get) => get(projectFaviconSourcesAtom).get(key) ?? null),
);
