import { CloudProjectId } from "@spiritdevs/contracts/cloudProject";
import { EnvironmentId, ProjectId } from "@spiritdevs/contracts";
import { EnvironmentBindingEntity } from "@spiritdevs/client-runtime/sync";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import { deriveProjectFaviconSources, projectFaviconSourceKey } from "./projectFaviconSources";

const remote = EnvironmentId.make("remote");
const local = EnvironmentId.make("local");
const projects = [
  {
    id: ProjectId.make("remote-project"),
    environmentId: remote,
    workspaceRoot: "/remote/quotecloud",
  },
  {
    id: ProjectId.make("local-project"),
    environmentId: local,
    workspaceRoot: "/local/quotecloud",
    faviconPath: "apps/dashboard/public/favicon.svg",
  },
];
const decodeBinding = Schema.decodeUnknownSync(EnvironmentBindingEntity);
const bindings = projects.map((project) =>
  decodeBinding({
    entityKind: "environmentBinding",
    id: `binding-${project.environmentId}`,
    cloudProjectId: "quotecloud",
    environmentId: project.environmentId,
    localProjectId: project.id,
    localWorkspaceRoot: project.workspaceRoot,
    status: "active",
    lastSeenAt: null,
    createdAt: 1000,
    updatedAt: 1000,
  }),
);
const input = {
  projects,
  bindings,
  preferredBindingIds: new Set(["binding-local"]),
  connectedEnvironmentIds: new Set([local, remote]),
};
const key = (environmentId: EnvironmentId) =>
  projectFaviconSourceKey(environmentId, `/${environmentId}/quotecloud`);

describe("project favicon sources", () => {
  it("uses the same source including its host and custom path for both thread projects", () => {
    const sources = deriveProjectFaviconSources(input);
    expect(sources.get(key(remote))).toEqual({
      environmentId: local,
      cwd: "/local/quotecloud",
      faviconPath: projects[1]!.faviconPath,
    });
    expect(sources.get(key(remote))).toBe(sources.get(key(local)));
  });

  it("prefers the chosen connection when neither checkout has a custom icon", () => {
    const sources = deriveProjectFaviconSources({
      ...input,
      projects: projects.map((project) => ({ ...project, faviconPath: null })),
    });
    expect(sources.get(key(remote))?.environmentId).toBe(local);
  });

  it("prefers an available custom icon over a preferred connection's automatic icon", () => {
    const sources = deriveProjectFaviconSources({
      ...input,
      preferredBindingIds: new Set(["binding-remote"]),
    });
    expect(sources.get(key(remote))?.environmentId).toBe(local);
  });

  it("switches both rows to an available host when the preferred host disconnects", () => {
    const sources = deriveProjectFaviconSources({
      ...input,
      connectedEnvironmentIds: new Set([remote]),
    });
    expect(sources.get(key(local))?.environmentId).toBe(remote);
    expect(sources.get(key(remote))).toBe(sources.get(key(local)));
  });

  it("does not share icons across distinct cloud projects or revoked bindings", () => {
    const separate = deriveProjectFaviconSources({
      ...input,
      bindings: bindings.map((binding) => ({
        ...binding,
        cloudProjectId: CloudProjectId.make(binding.id),
      })),
    });
    expect(separate.get(key(remote))?.environmentId).toBe(remote);
    const revoked = deriveProjectFaviconSources({
      ...input,
      bindings: bindings.map((binding) => ({ ...binding, status: "revoked" as const })),
    });
    expect(revoked.size).toBe(0);
  });

  it("leaves unbound, rootless and disconnected projects on their existing fallback", () => {
    expect(deriveProjectFaviconSources({ ...input, bindings: [] }).size).toBe(0);
    expect(deriveProjectFaviconSources({ ...input, connectedEnvironmentIds: new Set() }).size).toBe(
      0,
    );
    expect(
      deriveProjectFaviconSources({
        ...input,
        projects: projects.map((project) => ({ ...project, workspaceRoot: null })),
      }).size,
    ).toBe(0);
  });
});
