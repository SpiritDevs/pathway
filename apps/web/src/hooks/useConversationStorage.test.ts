import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ThreadId,
  DEFAULT_STORAGE_POLICY,
  type StoragePreview,
  type StorageSnapshot,
} from "@spiritdevs/contracts";
import { reactHookHarness } from "../test/reactHookHarness";
import { useConversationStorage } from "./useConversationStorage";
import { CompanyId } from "@spiritdevs/contracts/company";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  start: vi.fn(),
  cancel: vi.fn(),
  recreate: vi.fn(),
  refresh: vi.fn(),
  effects: [] as Array<() => void>,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness: harness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useState: harness.useState,
    useMemo: harness.useMemo,
    useRef: harness.useRef,
    useCallback: harness.useCallback,
    useEffect: (effect: () => void) => {
      mocks.effects.push(effect);
    },
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness: harness } = await import("../test/reactHookHarness");
  return { c: harness.useMemoCache };
});
vi.mock("../state/query", () => ({ useEnvironmentQuery: mocks.query }));
vi.mock("../state/server", () => ({
  serverEnvironment: {
    storageSnapshot: (input: unknown) => ({ type: "snapshot", input }),
    storagePreview: (input: unknown) => ({ type: "preview", input }),
    storageStart: mocks.start,
    storageCancel: mocks.cancel,
    storageRecreate: mocks.recreate,
  },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: (command: unknown) => command }));
vi.mock("../cloud/activeCompany", () => ({
  activeCompanyIdAtom: "company",
  scopedCompanyRegistryReplicasAtom: "replicas",
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) => (atom === "company" ? companyId : replicas),
}));

const environmentId = EnvironmentId.make("machine");
const threadId = ThreadId.make("thread");
const companyA = CompanyId.make("company-a");
const companyB = CompanyId.make("company-b");
let companyId = companyA;
const registration = {
  entityKind: "environmentRegistration",
  id: "registration",
  environmentId,
  publicKeyThumbprint: "thumbprint",
  descriptor: {
    environmentId,
    applicationId: "pathway",
    label: "Machine",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "2026.9.0",
    capabilities: { repositoryIdentity: true, storageManagement: true },
  },
  relayLinkState: "linked",
  managedEndpointAvailable: true,
  lastSeenAt: 1000,
  serviceRoleIds: [],
  teamIds: [],
  state: "active",
  registeredByMembershipId: null,
  createdAt: 1000,
  updatedAt: 1000,
};
const replicas = new Map(
  [companyA, companyB].map((id) => [id, { view: new Map([["registration", registration]]) }]),
);
let snapshot: StorageSnapshot | null;
let snapshotError: string | null;
let preview: StoragePreview;
const input = () => ({ environmentId, threadId, enabled: true, isStartingConversation: true });
const render = (override = {}) => {
  reactHookHarness.beginRender();
  return useConversationStorage({ ...input(), ...override });
};

beforeEach(() => {
  vi.clearAllMocks();
  reactHookHarness.reset();
  mocks.effects.length = 0;
  snapshotError = null;
  companyId = companyA;
  vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn() });
  const sampledAt = new Date().toISOString();
  snapshot = {
    sampledAt,
    policy: DEFAULT_STORAGE_POLICY,
    jobs: [],
    scanError: null,
    volumes: [
      {
        id: "disk",
        path: "/",
        totalBytes: 1000,
        availableBytes: 5,
        pressure: "critical",
        sampledAt,
      },
    ],
    worktrees: [
      {
        id: "eligible",
        path: "/worktree",
        projectRoot: "/project",
        branch: "saved",
        volumeId: "disk",
        threadIds: [threadId],
        estimatedBytes: 100,
        measuredAt: sampledAt,
        kind: "worktree",
        blockers: [],
        removed: false,
      },
    ],
    threads: [
      {
        threadId,
        title: "Company A work",
        projectId: null,
        conversationCompanyId: companyA,
        worktreeId: "eligible",
        status: "settled",
        keepWorktree: false,
        threadDataBytes: 0,
        eligibleSince: null,
        reclaimedAt: null,
      },
    ],
  };
  preview = {
    estimatedBytes: 100,
    items: [
      {
        worktreeId: "eligible",
        path: "/worktree",
        threadIds: [threadId],
        estimatedBytes: 100,
        eligible: true,
        blockers: [],
      },
      {
        worktreeId: "protected",
        path: "/busy",
        threadIds: [],
        estimatedBytes: 200,
        eligible: false,
        blockers: ["Running thread"],
      },
    ],
  };
  mocks.query.mockImplementation((atom: { type: string } | null) => ({
    data: atom ? (atom.type === "snapshot" ? snapshot : preview) : null,
    error: atom?.type === "snapshot" ? snapshotError : null,
    isPending: false,
    refresh: mocks.refresh,
  }));
  mocks.start.mockResolvedValue({
    _tag: "Success",
    value: {
      id: "job",
      mode: "emergency",
      status: "running",
      items: [],
      startedAt: sampledAt,
      finishedAt: null,
    },
  });
  mocks.cancel.mockResolvedValue({ _tag: "Success", value: {} });
  mocks.recreate.mockResolvedValue({ _tag: "Success", value: {} });
});
afterEach(() => vi.unstubAllGlobals());

describe("conversation storage", () => {
  it("previews and cleans only the active company's worktrees, excluding cross-company shared folders", async () => {
    const foreignThread = {
      ...snapshot!.threads[0]!,
      threadId: ThreadId.make("foreign-thread"),
      conversationCompanyId: companyB,
      worktreeId: "foreign",
    };
    snapshot = {
      ...snapshot!,
      threads: [...snapshot!.threads, foreignThread],
      worktrees: [
        ...snapshot!.worktrees,
        { ...snapshot!.worktrees[0]!, id: "foreign", threadIds: [foreignThread.threadId] },
        { ...snapshot!.worktrees[0]!, id: "shared", threadIds: [threadId, foreignThread.threadId] },
      ],
    };
    preview = {
      estimatedBytes: 900,
      items: [
        preview.items[0]!,
        {
          ...preview.items[0]!,
          worktreeId: "foreign",
          estimatedBytes: 400,
          threadIds: [foreignThread.threadId],
        },
        {
          ...preview.items[0]!,
          worktreeId: "shared",
          estimatedBytes: 400,
          threadIds: [threadId, foreignThread.threadId],
        },
      ],
    };
    const storage = render();
    expect(mocks.query).toHaveBeenCalledWith({
      type: "preview",
      input: { environmentId, input: { mode: "emergency", worktreeIds: ["eligible"] } },
    });
    expect(storage.preview.data?.estimatedBytes).toBe(100);
    expect(storage.preview.data?.items.map((item) => item.worktreeId)).toEqual(["eligible"]);
    await storage.cleanup();
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { mode: "emergency", worktreeIds: ["eligible"] },
    });
  });
  it("drops the previous company's preview and override immediately when company selection changes", async () => {
    render().allow();
    expect(render().allowed).toBe(true);
    companyId = companyB;
    const changed = render();
    expect(changed.allowed).toBe(false);
    expect(changed.preview.data?.estimatedBytes).toBe(0);
    expect(changed.preview.data?.items).toEqual([]);
    await changed.cleanup();
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("previews worktrees only on critically low disks", () => {
    snapshot = {
      ...snapshot!,
      worktrees: [
        snapshot!.worktrees[0]!,
        { ...snapshot!.worktrees[0]!, id: "other-disk", volumeId: "other" },
      ],
      volumes: [
        ...snapshot!.volumes,
        { ...snapshot!.volumes[0]!, id: "other", pressure: "warning" },
      ],
    };
    render();
    expect(mocks.query).toHaveBeenCalledWith({
      type: "preview",
      input: { environmentId, input: { mode: "emergency", worktreeIds: ["eligible"] } },
    });
  });
  it("allows sending under critical storage on drafts and existing threads", () => {
    expect(render().canSend).toBe(true);
    render().allow();
    expect(render().canSend).toBe(true);
    expect(render({ threadId: ThreadId.make("other") }).canSend).toBe(true);
    expect(render({ environmentId: EnvironmentId.make("other") }).canSend).toBe(true);
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("stops gating and previewing cleanup once the conversation starts, including after reopening", () => {
    expect(render().canSend).toBe(true);
    mocks.query.mockClear();
    const started = render({ isStartingConversation: false });
    const blocked = vi.fn();
    expect(started.allowed).toBe(true);
    expect(started.checkCanSend(blocked)).toBe(true);
    expect(blocked).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([atom]) => atom?.type === "preview")).toBe(false);

    reactHookHarness.reset();
    expect(render({ isStartingConversation: false }).canSend).toBe(true);
    expect(render({ threadId: ThreadId.make("new-draft") }).canSend).toBe(true);
  });
  it("checks imperative responses and recovery actions again after permission or workspace state changes", () => {
    const blocked = vi.fn();
    expect(render().checkCanSend(blocked)).toBe(true);
    expect(blocked).not.toHaveBeenCalled();
    render().allow();
    blocked.mockClear();
    expect(render().checkCanSend(blocked)).toBe(true);
    expect(blocked).not.toHaveBeenCalled();

    snapshot = {
      ...snapshot!,
      threads: [
        {
          threadId,
          title: "Reclaimed",
          projectId: "project",
          worktreeId: "eligible",
          status: "settled",
          keepWorktree: false,
          threadDataBytes: 0,
          eligibleSince: null,
          reclaimedAt: snapshot!.sampledAt,
        },
      ],
    };
    expect(render().checkCanSend(blocked)).toBe(false);
    expect(blocked).toHaveBeenLastCalledWith(true);
    snapshot = { ...snapshot!, threads: [{ ...snapshot!.threads[0]!, reclaimedAt: null }] };
    expect(render().checkCanSend(blocked)).toBe(true);
    expect(render({ environmentId: EnvironmentId.make("other") }).checkCanSend(blocked)).toBe(true);
  });
  it("does not block unknown or stale readings or legacy environments", () => {
    snapshotError = "Connection lost";
    expect(render().canSend).toBe(true);
    snapshotError = null;
    snapshot = { ...snapshot!, sampledAt: "2000-01-01T00:00:00.000Z" };
    expect(render().canSend).toBe(true);
    expect(render({ enabled: false }).canSend).toBe(true);
    snapshot = null;
    expect(render().canSend).toBe(true);
  });
  it("only starts cleanup after a click and bounds it to the eligible preview", async () => {
    const storage = render();
    mocks.effects.splice(0).forEach((effect) => effect());
    expect(mocks.start).not.toHaveBeenCalled();
    await storage.cleanup();
    expect(mocks.start).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { mode: "emergency", worktreeIds: ["eligible"] },
    });
    expect(render().job?.id).toBe("job");
    expect(render().canSend).toBe(true);
  });
  it("cannot submit a conversation while its worktree is reclaimed, even after continuing anyway", async () => {
    snapshot = {
      ...snapshot!,
      threads: [
        {
          threadId,
          title: "Saved history",
          projectId: "project",
          worktreeId: "eligible",
          status: "settled",
          keepWorktree: false,
          threadDataBytes: 20,
          eligibleSince: null,
          reclaimedAt: snapshot!.sampledAt,
        },
      ],
    };
    render().allow();
    expect(render().canSend).toBe(true);
    expect(render({ isStartingConversation: false }).canSend).toBe(false);
    await render().recreateWorktree();
    expect(mocks.recreate).toHaveBeenCalledExactlyOnceWith({ environmentId, input: { threadId } });
    expect(mocks.start).not.toHaveBeenCalled();
  });
  it("retries only failed worktrees that are still eligible", async () => {
    mocks.start.mockResolvedValueOnce({
      _tag: "Success",
      value: {
        id: "failed",
        mode: "emergency",
        status: "completed",
        items: [
          {
            worktreeId: "eligible",
            status: "failed",
            message: "Busy",
            estimatedBytes: 100,
            actualFreeDeltaBytes: null,
          },
        ],
        startedAt: snapshot!.sampledAt,
        finishedAt: snapshot!.sampledAt,
      },
    });
    await render().cleanup();
    preview = {
      ...preview,
      items: [
        ...preview.items,
        {
          worktreeId: "new-candidate",
          path: "/new",
          threadIds: [],
          estimatedBytes: 300,
          eligible: true,
          blockers: [],
        },
      ],
    };
    await render().retryCleanup();
    expect(mocks.start).toHaveBeenLastCalledWith({
      environmentId,
      input: { mode: "emergency", worktreeIds: ["eligible"] },
    });
  });
});
