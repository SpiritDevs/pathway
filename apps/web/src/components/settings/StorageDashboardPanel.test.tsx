import type { ComponentProps, ReactElement } from "react";
import {
  DEFAULT_STORAGE_POLICY,
  EnvironmentId,
  ThreadId,
  type StorageSnapshot,
} from "@spiritdevs/contracts";
import { scopeThreadRef } from "@spiritdevs/client-runtime/environment";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";
import { StorageDashboardPanel } from "./StorageDashboardPanel";
import { ConversationFolderDeleteDialog } from "./ConversationFolderDeleteDialog";

const state = vi.hoisted(() => ({
  entries: [] as unknown[],
  refresh: vi.fn(),
  deleteThread: vi.fn(),
  confirmAndDeleteThread: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, useState: reactHookHarness.useState, useMemo: reactHookHarness.useMemo };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../lib/storageDashboardState", () => ({
  useStorageDashboardState: () => ({ entries: state.entries, refresh: state.refresh }),
}));
vi.mock("../../lib/storagePreferences", () => ({
  useStorageDefaultPolicy: () => ({ canSave: false }),
}));
vi.mock("../../state/entities", () => ({ useActiveEnvironmentId: () => "remote-machine" }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../hooks/useThreadActions", () => ({
  useThreadActions: () => ({
    deleteThread: state.deleteThread,
    confirmAndDeleteThread: state.confirmAndDeleteThread,
  }),
}));
vi.mock("./LoadBalancingSettings", () => ({ StorageAutoPlacementSetting: () => null }));
vi.mock("./StoragePolicyDialog", () => ({ StoragePolicyDialog: () => null }));

const environmentId = EnvironmentId.make("remote-machine");
const thread: StorageSnapshot["threads"][number] = {
  threadId: ThreadId.make("folder-conversation"),
  title: "Unattached notes",
  projectId: null,
  worktreeId: "/conversations/notes",
  status: "archived",
  keepWorktree: false,
  threadDataBytes: 250,
  eligibleSince: null,
  reclaimedAt: null,
};
const worktree: StorageSnapshot["worktrees"][number] = {
  id: "/conversations/notes",
  path: "/conversations/notes",
  projectRoot: null,
  branch: null,
  volumeId: "disk",
  threadIds: [thread.threadId],
  estimatedBytes: 400,
  measuredAt: null,
  kind: "conversation",
  blockers: [],
  removed: false,
};
function setup(kind: "conversation" | "worktree" = "conversation") {
  state.entries = [
    {
      environment: { environmentId, label: "Remote Mac", connection: { phase: "connected" } },
      snapshot: {
        sampledAt: "2026-09-09T00:00:00Z",
        volumes: [],
        threads: [thread],
        worktrees: [{ ...worktree, kind }],
        jobs: [],
        scanError: null,
        policy: DEFAULT_STORAGE_POLICY,
      },
      error: null,
      isLoading: false,
    },
  ];
}
function render() {
  hooks.beginRender();
  return StorageDashboardPanel();
}
function requestDeletion() {
  const tab = visitElements(render(), (element) => element.props.children === "Archived threads");
  (tab!.props.onClick as () => void)();
  const button = visitElements(render(), (element) => element.props.children === "Delete thread…");
  expect(button).not.toBeNull();
  (button!.props.onClick as () => void)();
}
function deletionDialog() {
  return visitElements(
    render(),
    (element) => element.type === ConversationFolderDeleteDialog,
  ) as ReactElement<ComponentProps<typeof ConversationFolderDeleteDialog>> | null;
}

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  state.deleteThread.mockResolvedValue({ _tag: "Success", value: undefined });
  // Model ordinary deletion with its confirmation preference disabled: it deletes immediately.
  state.confirmAndDeleteThread.mockImplementation((ref: unknown) => state.deleteThread(ref));
  setup();
});

it("requires the working-folder preview even when ordinary deletion confirmation is disabled", () => {
  requestDeletion();
  const dialog = deletionDialog();
  expect(dialog?.props.thread).toBe(thread);
  expect(dialog?.props.worktree.path).toBe(worktree.path);
  expect(dialog?.props.environmentLabel).toBe("Remote Mac");
  expect(state.confirmAndDeleteThread).not.toHaveBeenCalled();
  expect(state.deleteThread).not.toHaveBeenCalled();
});

it("cancels the folder preview without deleting the conversation or folder", () => {
  requestDeletion();
  deletionDialog()!.props.onClose();
  expect(deletionDialog()).toBeNull();
  expect(state.deleteThread).not.toHaveBeenCalled();
  expect(state.confirmAndDeleteThread).not.toHaveBeenCalled();
});

it("deletes only the explicitly reviewed environment and conversation after confirmation", async () => {
  requestDeletion();
  deletionDialog()!.props.onDelete();
  await state.deleteThread.mock.results[0]?.value;
  expect(state.deleteThread).toHaveBeenCalledExactlyOnceWith(
    scopeThreadRef(environmentId, thread.threadId),
  );
  expect(state.confirmAndDeleteThread).not.toHaveBeenCalled();
  expect(deletionDialog()).toBeNull();
});

it("keeps ordinary Git worktree deletion on the existing generic confirmation path", async () => {
  setup("worktree");
  requestDeletion();
  await state.confirmAndDeleteThread.mock.results[0]?.value;
  expect(state.confirmAndDeleteThread).toHaveBeenCalledExactlyOnceWith(
    scopeThreadRef(environmentId, thread.threadId),
  );
  expect(deletionDialog()).toBeNull();
});

it("defaults to the current environment and switches the thread list using a card", () => {
  const other = {
    ...(state.entries[0] as Record<string, unknown>),
    environment: { environmentId: "other", label: "Other", connection: { phase: "connected" } },
    snapshot: { ...(state.entries[0] as { snapshot: object }).snapshot, threads: [] },
  };
  state.entries.unshift(other);
  const currentCard = visitElements(render(), (element) => element.props.selected === true);
  expect(
    (currentCard!.props.entry as { environment: { environmentId: string } }).environment
      .environmentId,
  ).toBe("remote-machine");
  const otherCard = visitElements(
    render(),
    (element) => element.props.entry === other && typeof element.props.onSelect === "function",
  );
  (otherCard!.props.onSelect as () => void)();
  expect(visitElements(render(), (element) => element.props.thread === thread)).toBeNull();
  expect(
    visitElements(
      render(),
      (element) => element.props.entry === other && element.props.selected === true,
    ),
  ).not.toBeNull();
});
