import { EnvironmentId, MessageId, ProjectId, ThreadId } from "@spiritdevs/contracts";
import { scopeProjectRef } from "@spiritdevs/client-runtime/environment";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useHandleNewThread, useNewThreadHandler } from "./useHandleNewThread";
import { selectSidebarDraftRows } from "../components/sidebarDrafts";

const mocks = vi.hoisted(() => ({
  activeThread: null as { environmentId: string; projectId: string } | null,
  readShell: vi.fn(),
  readDefaults: vi.fn(),
  navigate: vi.fn().mockResolvedValue(undefined),
  routeParams: {} as Record<string, string>,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ defaultThreadEnvMode: "local", newWorktreesStartFromOrigin: false }),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: ({ select }: { select: (params: Record<string, string>) => unknown }) =>
    select(mocks.routeParams),
  useRouter: () => ({
    state: { matches: [{ params: mocks.routeParams }] },
    navigate: mocks.navigate,
  }),
}));
vi.mock("../state/server", () => ({ primaryServerSettingsAtom: {} }));
vi.mock("./useSettings", () => ({ useClientSettings: () => ({}) }));
vi.mock("../state/entities", () => ({
  useProjects: () => [
    { id: "project-a", environmentId: "env-a", workspaceRoot: "/repo-a" },
    { id: "project-b", environmentId: "env-b", workspaceRoot: "/repo-b" },
  ],
  useThreadShell: () => mocks.activeThread,
  useServerConfigs: () => new Map(),
  readThreadShell: mocks.readShell,
}));
vi.mock("../logicalProject", () => ({
  getProjectOrderKey: (project: { id: string }) => project.id,
  deriveLogicalProjectKeyFromSettings: () => "shared-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../lib/pathwayProjectFileDefaults", () => ({
  readPathwayProjectFileDefaultThreadEnvMode: mocks.readDefaults,
}));

function createHandler() {
  let handler: ReturnType<typeof useNewThreadHandler> | undefined;
  function Harness() {
    handler = useNewThreadHandler();
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  return handler!;
}

describe("new-thread creation while project defaults load", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readShell.mockReset().mockReturnValue(null);
    mocks.routeParams = {};
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      stickyModelSelectionByProvider: {},
      stickyActiveProvider: null,
    });
  });

  afterEach(() => {
    useComposerDraftStore.persist.clearStorage();
  });

  it.each([
    ["draft", "thread", false],
    ["draft", "composer", false],
    ["server", "thread", false],
    ["server", "composer", false],
    ["draft", "thread", true],
    ["draft", "composer", true],
    ["server", "thread", true],
    ["server", "composer", true],
  ] as const)(
    "%s route with %s settings only carries working modes within the active profile (%s)",
    async (routeKind, settingsSource, sameProfile) => {
      const store = useComposerDraftStore.getState();
      const sourceProject = scopeProjectRef(
        EnvironmentId.make(sameProfile ? "env-a" : "old-env"),
        ProjectId.make(sameProfile ? "project-a" : "old-project"),
      );
      const sourceId = DraftId.make("mode-source");
      store.setLogicalProjectDraftThreadId("mode-source-project", sourceProject, sourceId, {
        runtimeMode: settingsSource === "thread" ? "approval-required" : "full-access",
        interactionMode: settingsSource === "thread" ? "plan" : "default",
      });
      const source = store.getDraftSession(sourceId)!;
      const composerRef =
        routeKind === "draft"
          ? sourceId
          : { environmentId: source.environmentId, threadId: source.threadId };
      if (routeKind === "draft") {
        mocks.routeParams = { draftId: sourceId };
      } else {
        mocks.routeParams = { environmentId: source.environmentId, threadId: source.threadId };
        mocks.readShell.mockImplementation((ref: { threadId: string }) =>
          ref.threadId === source.threadId ? source : null,
        );
      }
      if (settingsSource === "composer") {
        store.setRuntimeMode(composerRef, "approval-required");
        store.setInteractionMode(composerRef, "plan");
      }
      const opened = await createHandler()(
        scopeProjectRef(EnvironmentId.make("env-b"), ProjectId.make("project-b")),
        { envMode: "local" },
      );
      expect(store.getDraftSession(opened!.draftId)).toMatchObject({
        runtimeMode: sameProfile ? "approval-required" : "full-access",
        interactionMode: sameProfile ? "plan" : "default",
      });
    },
  );

  it("leaves the current message in the sidebar when New Thread starts a separate draft", async () => {
    const projectA = scopeProjectRef(EnvironmentId.make("env-a"), ProjectId.make("project-a"));
    const projectB = scopeProjectRef(EnvironmentId.make("env-b"), ProjectId.make("project-b"));
    const handler = createHandler();
    const original = await handler(projectA, { envMode: "local" });
    expect(original).not.toBeNull();
    mocks.routeParams = { draftId: original!.draftId };
    const store = useComposerDraftStore.getState();
    store.setPrompt(original!.draftId, "Save this idea for later");

    const fresh = await handler(projectA, { envMode: "local" });
    expect(fresh).not.toBeNull();
    expect(fresh?.draftId).not.toBe(original?.draftId);
    expect(store.getComposerDraft(fresh!.draftId)?.prompt ?? "").toBe("");

    store.setLogicalProjectDraftThreadId("another-project", projectB, fresh!.draftId);
    store.setPrompt(fresh!.draftId, "A separate idea");
    expect(store.getDraftSession(original!.draftId)?.projectId).toBe(projectA.projectId);
    expect(store.getComposerDraft(original!.draftId)?.prompt).toBe("Save this idea for later");
    const state = useComposerDraftStore.getState();
    expect(
      selectSidebarDraftRows({
        draftThreadsByThreadKey: state.draftThreadsByThreadKey,
        draftsByThreadKey: state.draftsByThreadKey,
        serverThreadKeys: new Set(),
        routeDraftId: fresh!.draftId,
        scopedProjectKeys: null,
        frozenActive: { routeDraftId: fresh!.draftId, row: null },
      }).map((row) => row.draftId),
    ).toEqual([original!.draftId]);
  });

  it.each(["pending send", "typed content", "empty"] as const)(
    "rechecks a raced draft with %s before remapping its environment",
    async (content) => {
      let resolveDefaults!: (value: "local") => void;
      const defaults = new Promise<"local">((resolve) => {
        resolveDefaults = resolve;
      });
      mocks.readDefaults.mockReturnValueOnce(defaults);
      const projectA = scopeProjectRef(EnvironmentId.make("env-a"), ProjectId.make("project-a"));
      const projectB = scopeProjectRef(EnvironmentId.make("env-b"), ProjectId.make("project-b"));
      const handler = createHandler();
      const waiting = handler(projectB);
      expect(mocks.readDefaults).toHaveBeenCalledWith(projectB.environmentId, "/repo-b");

      // A second invocation finishes first and the user can send or type
      // before the first invocation's project-file request returns.
      const winner = await handler(projectA, { envMode: "local" });
      expect(winner).not.toBeNull();
      const store = useComposerDraftStore.getState();
      const winnerId = DraftId.make(winner!.draftId);
      if (content === "pending send") {
        store.setPrompt(winnerId, "Start work");
        store.setDraftPendingSend(winnerId, {
          messageId: MessageId.make("pending-message"),
          text: "Start work",
          title: "Start work",
          createdAt: "2026-09-08T00:00:00.000Z",
        });
        store.clearComposerContent(winnerId);
      } else if (content === "typed content") {
        store.setPrompt(winnerId, "Keep this draft");
      }
      resolveDefaults("local");
      const result = await waiting;
      expect(result).not.toBeNull();

      if (content === "empty") {
        expect(result?.draftId).toBe(winnerId);
        expect(store.getDraftSession(winnerId)?.environmentId).toBe(projectB.environmentId);
      } else {
        expect(result?.draftId).not.toBe(winnerId);
        expect(store.getDraftSession(winnerId)).toMatchObject({
          environmentId: projectA.environmentId,
          projectId: projectA.projectId,
          threadId: ThreadId.make(winner!.threadId),
        });
        expect(store.getDraftSession(result!.draftId)?.environmentId).toBe(projectB.environmentId);
        if (content === "pending send") {
          expect(store.getDraftSession(winnerId)?.pendingSend?.messageId).toBe("pending-message");
        } else {
          expect(store.getComposerDraft(winnerId)?.prompt).toBe("Keep this draft");
        }
      }
    },
  );
});

function readNewThreadContext() {
  let context: ReturnType<typeof useHandleNewThread> | undefined;
  function Harness() {
    context = useHandleNewThread();
    return null;
  }
  renderToStaticMarkup(createElement(Harness));
  return context!;
}

describe("new-thread project after switching profiles", () => {
  afterEach(() => {
    mocks.activeThread = null;
    mocks.routeParams = {};
    useComposerDraftStore.persist.clearStorage();
  });

  it.each(["thread", "draft"])("ignores a %s from the previous profile", (kind) => {
    const previousProject = scopeProjectRef(
      EnvironmentId.make("old-env"),
      ProjectId.make("old-project"),
    );
    if (kind === "thread") {
      mocks.activeThread = previousProject;
    } else {
      const draftId = DraftId.make("previous-profile-draft");
      useComposerDraftStore
        .getState()
        .setLogicalProjectDraftThreadId("old-profile", previousProject, draftId);
      mocks.routeParams = { draftId };
    }
    const context = readNewThreadContext();
    expect(context.activeThread).toBeNull();
    expect(context.activeDraftThread).toBeNull();
    expect(context.defaultProjectRef).toEqual(
      scopeProjectRef(EnvironmentId.make("env-a"), ProjectId.make("project-a")),
    );
  });

  it("retains the current project within the selected profile", () => {
    mocks.activeThread = { environmentId: "env-b", projectId: "project-b" };
    expect(readNewThreadContext().activeThread).toEqual(mocks.activeThread);
  });

  it("does not inherit a project from another environment with the same ID", () => {
    mocks.activeThread = { environmentId: "old-env", projectId: "project-a" };
    expect(readNewThreadContext().activeThread).toBeNull();
  });
});
