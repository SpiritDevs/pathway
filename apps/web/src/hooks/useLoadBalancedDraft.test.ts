import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type HostResourcesSnapshot,
  type ServerProvider,
} from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import { scopeProjectRef } from "@spiritdevs/client-runtime/environment";
import { EnvironmentBindingEntity } from "@spiritdevs/client-runtime/sync";
import * as Schema from "effect/Schema";
import { Atom, AtomRegistry, AsyncResult } from "effect/unstable/reactivity";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import type { Project } from "../types";
import type { EnvironmentPresentation } from "../state/environments";
import { reactHookHarness } from "../test/reactHookHarness";
import { useLoadBalancedDraft } from "./useLoadBalancedDraft";

const mocks = vi.hoisted(() => ({
  atomValue: vi.fn(),
  context: vi.fn(),
  resources: vi.fn(),
  session: vi.fn(),
  effects: [] as Array<() => void>,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness: harness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useMemo: harness.useMemo,
    useCallback: harness.useCallback,
    useContext: mocks.context,
    useEffect: (effect: () => void) => {
      mocks.effects.push(effect);
    },
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness: harness } = await import("../test/reactHookHarness");
  return { c: harness.useMemoCache };
});
vi.mock("@effect/atom-react", () => ({ RegistryContext: {}, useAtomValue: mocks.atomValue }));
vi.mock("../state/server", () => ({ serverEnvironment: { hostResources: mocks.resources } }));
vi.mock("../state/session", () => ({ environmentSession: { sessionStateAtom: mocks.session } }));
vi.mock("../composerDraftStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../composerDraftStore")>();
  return {
    ...actual,
    useComposerDraftStore: Object.assign(
      (selector: (state: ReturnType<typeof actual.useComposerDraftStore.getState>) => unknown) =>
        selector(actual.useComposerDraftStore.getState()),
      actual.useComposerDraftStore,
    ),
  };
});

const draftId = DraftId.make("placement-hook-draft");
const provider: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  status: "ready",
  auth: { status: "authenticated" },
  version: "1",
  checkedAt: "2026-09-08T00:00:00.000Z",
  models: [
    { slug: "model", name: "Model", isCustom: false, capabilities: null },
    { slug: "other", name: "Other", isCustom: false, capabilities: null },
  ],
  slashCommands: [],
  skills: [],
};
const remoteProvider = { ...provider, instanceId: ProviderInstanceId.make("codex-remote") };
const selection = { instanceId: provider.instanceId, model: "model" };
function project(id: string): Project {
  return {
    id: ProjectId.make(`project-${id}`),
    environmentId: EnvironmentId.make(id),
    title: id,
    workspaceRoot: `/${id}/repo`,
    defaultModelSelection: selection,
    scripts: [],
    createdAt: "2026-09-08",
    updatedAt: "2026-09-08",
  };
}
const local = project("local");
const remote = project("remote");
const decodeBinding = Schema.decodeUnknownSync(EnvironmentBindingEntity);
function projectReplicas(projects: ReadonlyArray<Project>) {
  return new Map([
    [
      CompanyId.make("company"),
      {
        view: new Map(
          projects.map((project) => [
            project.id,
            decodeBinding({
              entityKind: "environmentBinding",
              id: `binding-${project.id}`,
              cloudProjectId: "cloud-project",
              environmentId: project.environmentId,
              localProjectId: project.id,
              localWorkspaceRoot: project.workspaceRoot,
              status: "active",
              lastSeenAt: null,
              createdAt: 1,
              updatedAt: 1,
            }),
          ]),
        ),
      },
    ],
  ]);
}
const replicas = projectReplicas([local, remote]);
// The hook reads only connection phase and providers from these presentations.
const environments = [local, remote].map((project) => ({
  environmentId: project.environmentId,
  label: project.title,
  connection: { phase: "connected" },
  serverConfig: { providers: [project === local ? provider : remoteProvider] },
})) as unknown as ReadonlyArray<EnvironmentPresentation>;
const snapshot: HostResourcesSnapshot = {
  sampledAt: 20_000,
  cpuUtilization: 0.1,
  cpuCount: 8,
  availableMemoryBytes: 800,
  totalMemoryBytes: 1000,
};
let registry: AtomRegistry.AtomRegistry;
let localResources: Atom.Writable<AsyncResult.AsyncResult<HostResourcesSnapshot>>;
let remoteResources: Atom.Writable<AsyncResult.AsyncResult<HostResourcesSnapshot>>;
const store = () => useComposerDraftStore.getState();
const readDraft = () => store().getDraftSession(draftId)!;
const base = () => ({
  draftId,
  enabled: true,
  weights: {},
  project: local,
  projects: [local, remote],
  environments,
  replicas,
  selection,
});
function render(input: Parameters<typeof useLoadBalancedDraft>[0] = base()) {
  reactHookHarness.beginRender();
  return useLoadBalancedDraft(input);
}
function flushEffects() {
  const effects = mocks.effects.splice(0);
  effects.forEach((effect) => effect());
}

beforeEach(() => {
  vi.clearAllMocks();
  reactHookHarness.reset();
  mocks.effects.length = 0;
  vi.spyOn(Date, "now").mockReturnValue(20_000);
  registry = AtomRegistry.make();
  mocks.context.mockReturnValue(registry);
  mocks.atomValue.mockImplementation((atom: Atom.Atom<unknown>) => registry.get(atom));
  localResources = Atom.make<AsyncResult.AsyncResult<HostResourcesSnapshot>>(
    AsyncResult.success({ ...snapshot, cpuCount: 2 }, { timestamp: 20_000 }),
  );
  remoteResources = Atom.make<AsyncResult.AsyncResult<HostResourcesSnapshot>>(
    AsyncResult.success(snapshot, { timestamp: 20_000 }),
  );
  mocks.resources.mockImplementation(({ environmentId }: { environmentId: string }) =>
    environmentId === "local" ? localResources : remoteResources,
  );
  const session = Atom.make(
    AsyncResult.success({ authenticated: true, scopes: [AuthOrchestrationOperateScope] }),
  );
  mocks.session.mockReturnValue(session);
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
  store().setProjectDraftThreadId(scopeProjectRef(local.environmentId, local.id), draftId);
  store().setModelSelection(draftId, selection);
});
afterEach(() => {
  registry.dispose();
  vi.restoreAllMocks();
});

describe("useLoadBalancedDraft", () => {
  it("keeps projectless conversations on their selected environment without project balancing", () => {
    store().setDraftThreadContext(draftId, {
      projectRef: { environmentId: local.environmentId, projectId: null },
      conversationCompanyId: CompanyId.make("conversation-company"),
      temporary: true,
    });
    const result = render({ ...base(), project: null });
    flushEffects();
    expect(result.visible).toBe(false);
    expect(result.automatic).toBe(false);
    expect(result.blocked).toBe(false);
    expect(result.validate(selection)).toBe(true);
    expect(mocks.resources).not.toHaveBeenCalled();
    expect(mocks.session).not.toHaveBeenCalled();
    expect(readDraft()).toMatchObject({
      environmentId: local.environmentId,
      projectId: null,
      conversationCompanyId: "conversation-company",
      temporary: true,
    });
  });

  it("discards a measured project placement when the draft became a conversation", () => {
    render();
    store().setDraftThreadContext(draftId, {
      projectRef: { environmentId: local.environmentId, projectId: null },
      conversationCompanyId: CompanyId.make("conversation-company"),
    });
    flushEffects();
    expect(readDraft()).toMatchObject({
      environmentId: local.environmentId,
      projectId: null,
      conversationCompanyId: "conversation-company",
    });
    expect(store().getComposerDraft(draftId)?.activeProvider).toBe(provider.instanceId);
  });

  it("does no resource reads when disabled or rootless", () => {
    expect(render({ ...base(), enabled: false }).blocked).toBe(false);
    flushEffects();
    expect(render({ ...base(), project: { ...local, workspaceRoot: null } }).blocked).toBe(false);
    flushEffects();
    expect(mocks.resources).not.toHaveBeenCalled();
  });
  it("resolves the remote project and its environment-local provider instance", () => {
    render();
    flushEffects();
    expect(readDraft()).toMatchObject({
      environmentId: remote.environmentId,
      projectId: remote.id,
      placement: { mode: "auto" },
    });
    expect(store().getComposerDraft(draftId)?.activeProvider).toBe(remoteProvider.instanceId);
  });
  it("retains its resolved destination as headroom changes and blocks a disconnected destination", () => {
    render();
    flushEffects();
    const selected = { ...selection, instanceId: remoteProvider.instanceId };
    const input = { ...base(), project: remote, selection: selected };
    expect(render(input).validate(selected)).toBe(true);
    flushEffects();
    mocks.resources.mockClear();
    registry.set(
      localResources,
      AsyncResult.success({ ...snapshot, cpuCount: 128 }, { timestamp: 20_000 }),
    );
    render(input);
    flushEffects();
    expect(readDraft().environmentId).toBe(remote.environmentId);
    expect(mocks.resources).not.toHaveBeenCalled();
    const disconnected = render({
      ...input,
      environments: environments.map((environment) =>
        environment.environmentId === remote.environmentId
          ? { ...environment, connection: { ...environment.connection, phase: "offline" } }
          : environment,
      ),
    });
    expect(disconnected.blocked).toBe(true);
    expect(disconnected.validate(selected)).toBe(false);
  });
  it("preserves the exact source checkout when another local binding is listed first", () => {
    const other = { ...local, id: ProjectId.make("other-local"), workspaceRoot: "/local/other" };
    render({
      ...base(),
      projects: [other, remote, local],
      replicas: projectReplicas([other, remote, local]),
      weights: { local: 100, remote: 0 },
    });
    flushEffects();
    expect(readDraft().projectId).toBe(local.id);
    expect(readDraft().environmentId).toBe(local.environmentId);
  });
  it.each([true, false])(
    "excludes a remote environment with ambiguous bindings (both checkouts loaded: %s)",
    (bothLoaded) => {
      const other = {
        ...remote,
        id: ProjectId.make("other-remote"),
        workspaceRoot: "/remote/other",
      };
      render({
        ...base(),
        projects: bothLoaded ? [other, remote, local] : [local, remote],
        replicas: projectReplicas([local, remote, other]),
      });
      flushEffects();
      expect(readDraft().environmentId).toBe(local.environmentId);
      expect(
        mocks.resources.mock.calls.every(([input]) => input.environmentId === local.environmentId),
      ).toBe(true);
    },
  );
  it.each(["sticky", "project"] as const)(
    "pins an inherited custom account from %s defaults",
    (origin) => {
      const custom = { ...provider, instanceId: ProviderInstanceId.make("codex-personal") };
      const customSelection = { ...selection, instanceId: custom.instanceId };
      if (origin === "sticky") {
        store().setStickyModelSelection(customSelection);
        store().applyStickyState(draftId);
      } else {
        store().applyStickyState(draftId, customSelection);
      }
      const result = render({
        ...base(),
        project: {
          ...local,
          defaultModelSelection: origin === "project" ? customSelection : selection,
        },
        selection: customSelection,
        environments: environments.map((environment) =>
          environment.environmentId === local.environmentId
            ? {
                ...environment,
                serverConfig: { ...environment.serverConfig!, providers: [provider, custom] },
              }
            : environment,
        ),
      });
      flushEffects();
      expect(result.pinned).toBe(true);
      expect(result.automatic).toBe(false);
      expect(result.machinePinned).toBe(false);
      expect(mocks.resources).not.toHaveBeenCalled();
      result.recheck();
      expect(readDraft().placement).toBeUndefined();
      expect(store().getComposerDraft(draftId)?.activeProvider).toBe(custom.instanceId);
    },
  );
  it("keeps Auto provenance across a recheck and model change after mapping a custom instance", () => {
    render();
    flushEffects();
    const selected = { ...selection, instanceId: remoteProvider.instanceId };
    const result = render({ ...base(), project: remote, selection: selected });
    expect(result.pinned).toBe(false);
    result.recheck();
    expect(readDraft().placement?.automaticProviderInstanceId).toBe(remoteProvider.instanceId);
    store().setModelSelection(draftId, { ...selected, model: "other" });
    const changed = render({
      ...base(),
      project: remote,
      selection: { ...selected, model: "other" },
    });
    expect(changed.automatic).toBe(true);
    expect(changed.pinned).toBe(false);
    flushEffects();
    expect(readDraft().placement?.automaticProviderInstanceId).toBe(remoteProvider.instanceId);
  });
  it("does not use another account on the source machine when its selected instance is unavailable", () => {
    const other = { ...provider, instanceId: ProviderInstanceId.make("codex-other") };
    const result = render({
      ...base(),
      weights: { remote: 0 },
      environments: environments.map((environment) =>
        environment.environmentId === local.environmentId
          ? {
              ...environment,
              serverConfig: {
                ...environment.serverConfig!,
                providers: [{ ...provider, auth: { status: "unauthenticated" as const } }, other],
              },
            }
          : environment,
      ),
    });
    flushEffects();
    expect(result.blocked).toBe(true);
    expect(mocks.resources).not.toHaveBeenCalled();
    expect(store().getComposerDraft(draftId)?.activeProvider).toBe(provider.instanceId);
  });
  it("discards a late measurement when the model changes before its effect commits", () => {
    render();
    store().setModelSelection(draftId, { ...selection, model: "other" });
    flushEffects();
    expect(readDraft().environmentId).toBe(local.environmentId);
    expect(
      store().getComposerDraft(draftId)?.modelSelectionByProvider[provider.instanceId]?.model,
    ).toBe("other");
  });
  it("discards a late measurement when option values change before its effect commits", () => {
    render();
    store().setModelSelection(
      draftId,
      { ...selection, options: [{ id: "effort", value: "high" }] },
      { replaceOptions: true },
    );
    flushEffects();
    expect(readDraft().environmentId).toBe(local.environmentId);
    expect(
      store().getComposerDraft(draftId)?.modelSelectionByProvider[provider.instanceId]?.options,
    ).toEqual([{ id: "effort", value: "high" }]);
  });
  it("pins an attachment that arrives before the resource effect commits", () => {
    render();
    store().addImages(draftId, [
      {
        type: "image",
        id: "image",
        name: "image.png",
        mimeType: "image/png",
        sizeBytes: 1,
        previewUrl: "blob:image",
        file: new File([new Uint8Array([1])], "image.png", { type: "image/png" }),
      },
    ]);
    flushEffects();
    expect(readDraft().environmentId).toBe(local.environmentId);
    expect(render().pinned).toBe(true);
  });
  it.each(["branch", "worktree", "provider", "dispatch"] as const)(
    "does not move a draft pinned by %s",
    (pin) => {
      render();
      store().setDraftThreadContext(
        draftId,
        pin === "branch"
          ? { branch: "main" }
          : pin === "worktree"
            ? { envMode: "worktree" }
            : {
                placement: {
                  mode: "auto",
                  providerPinned: pin === "provider",
                  resolvedKey: null,
                  dispatched: pin === "dispatch",
                },
              },
      );
      flushEffects();
      expect(readDraft().environmentId).toBe(local.environmentId);
      mocks.resources.mockClear();
      expect(render().pinned).toBe(true);
      expect(mocks.resources).not.toHaveBeenCalled();
    },
  );
  it("does not let a captured recheck callback remove a newly dispatched pin", () => {
    const result = render();
    store().setDraftThreadContext(draftId, {
      placement: { mode: "auto", resolvedKey: null, providerPinned: false, dispatched: true },
    });
    result.recheck();
    flushEffects();
    expect(readDraft().placement?.dispatched).toBe(true);
    expect(readDraft().environmentId).toBe(local.environmentId);
  });
  it("requires an explicit manual choice when no host has measurable headroom", () => {
    registry.set(
      localResources,
      AsyncResult.success({ ...snapshot, cpuUtilization: null }, { timestamp: 20_000 }),
    );
    registry.set(
      remoteResources,
      AsyncResult.success({ ...snapshot, cpuUtilization: 0.99 }, { timestamp: 20_000 }),
    );
    const result = render();
    flushEffects();
    expect(result.blocked).toBe(true);
    result.useManual();
    expect(render().blocked).toBe(false);
  });
});
