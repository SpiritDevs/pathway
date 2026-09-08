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
  instanceId: ProviderInstanceId.make("codex-local"),
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
const replicas = new Map([
  [
    CompanyId.make("company"),
    {
      view: new Map(
        [local, remote].map((project) => [
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
