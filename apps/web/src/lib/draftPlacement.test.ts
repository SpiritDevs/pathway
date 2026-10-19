import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import type { EnvironmentProject } from "@spiritdevs/client-runtime/state/models";
import { EnvironmentBindingEntity } from "@spiritdevs/client-runtime/sync";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  placementSelectionKey,
  selectPlacementProjects,
  resolvePlacementModel,
} from "./draftPlacement";

const source: Pick<EnvironmentProject, "environmentId" | "id" | "workspaceRoot"> = {
  environmentId: EnvironmentId.make("local"),
  id: ProjectId.make("project-local"),
  workspaceRoot: "/local/repo",
};
const target: typeof source = {
  environmentId: EnvironmentId.make("remote"),
  id: ProjectId.make("project-remote"),
  workspaceRoot: "/remote/repo",
};
const decodeBinding = Schema.decodeUnknownSync(EnvironmentBindingEntity);
function binding(project: typeof source, company = "company-a", cloudProject = "cloud-project") {
  return {
    companyId: CompanyId.make(company),
    binding: decodeBinding({
      entityKind: "environmentBinding",
      id: `binding-${project.id}`,
      cloudProjectId: cloudProject,
      environmentId: project.environmentId,
      localProjectId: project.id,
      localWorkspaceRoot: project.workspaceRoot,
      status: "active",
      lastSeenAt: null,
      createdAt: 1,
      updatedAt: 1,
    }),
  };
}
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex-local"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  version: "1",
  checkedAt: "2026-09-08T00:00:00.000Z",
  models: [
    {
      slug: "model",
      name: "Model",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: [{ id: "high", label: "High" }],
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
};
const selection = {
  instanceId: provider.instanceId,
  model: "model",
  options: [{ id: "effort", value: "high" }],
};

describe("automatic draft placement eligibility", () => {
  it("uses explicit bindings within the same company and cloud project", () => {
    expect(
      selectPlacementProjects(source, [source, target], [binding(source), binding(target)]),
    ).toEqual([source, target]);
    expect(
      selectPlacementProjects(
        source,
        [source, target],
        [binding(source), binding(target, "company-b")],
      ),
    ).toEqual([source]);
    expect(
      selectPlacementProjects(
        source,
        [source, target],
        [binding(source), binding(target, "company-a", "other-project")],
      ),
    ).toEqual([source]);
    expect(selectPlacementProjects(source, [source, target], [])).toEqual([source]);
  });
  it("retains the current checkout and excludes rootless projects", () => {
    expect(selectPlacementProjects(source, [source, target], [])).toEqual([source]);
    expect(
      selectPlacementProjects(
        { ...source, workspaceRoot: null },
        [target],
        [binding(source), binding(target)],
      ),
    ).toEqual([]);
  });
  it("maps a driver and model to the target environment's distinct instance ID", () => {
    const remote = { ...provider, instanceId: ProviderInstanceId.make("codex-remote") };
    expect(resolvePlacementModel(selection, provider, [remote])).toEqual({
      ...selection,
      instanceId: remote.instanceId,
    });
  });
  it("rejects unavailable providers, unknown authentication, other drivers and unsupported models/options", () => {
    for (const candidate of [
      { ...provider, enabled: false },
      { ...provider, installed: false },
      { ...provider, auth: { status: "unknown" as const } },
      { ...provider, driver: ProviderDriverKind.make("claudeAgent") },
      { ...provider, models: [] },
      { ...provider, models: [{ ...provider.models[0]!, capabilities: null }] },
    ])
      expect(resolvePlacementModel(selection, provider, [candidate])).toBeNull();
    expect(
      resolvePlacementModel({ ...selection, options: [{ id: "effort", value: "max" }] }, provider, [
        provider,
      ]),
    ).toBeNull();
  });
  it("invalidates placement on environment, project, model, instance and option changes", () => {
    const key = placementSelectionKey(source.environmentId, source.id, selection);
    expect(placementSelectionKey(target.environmentId, source.id, selection)).not.toBe(key);
    expect(placementSelectionKey(source.environmentId, target.id, selection)).not.toBe(key);
    expect(
      placementSelectionKey(source.environmentId, source.id, { ...selection, model: "other" }),
    ).not.toBe(key);
    expect(
      placementSelectionKey(source.environmentId, source.id, {
        ...selection,
        instanceId: ProviderInstanceId.make("other"),
      }),
    ).not.toBe(key);
    expect(
      placementSelectionKey(source.environmentId, source.id, { ...selection, options: [] }),
    ).not.toBe(key);
  });
});
