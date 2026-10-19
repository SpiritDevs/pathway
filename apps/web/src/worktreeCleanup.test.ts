import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";
import { makeThreadFixture } from "./test-fixtures";
import {
  formatWorktreePathForDisplay,
  getOrphanedWorktreePathForThread,
  getClientWorktreeCleanupPathForThread,
} from "./worktreeCleanup";

const localEnvironmentId = EnvironmentId.make("environment-local");

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    id: ThreadId.make("thread-1"),
    environmentId: localEnvironmentId,
    projectId: ProjectId.make("project-1"),
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.3-codex",
    },
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    runtime: null,
    messages: [],
    proposedPlans: [],
    createdAt: "2026-02-13T00:00:00.000Z",
    updatedAt: "2026-02-13T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestRun: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  });
}

describe("getOrphanedWorktreePathForThread", () => {
  it("returns null when the target thread does not exist", () => {
    const result = getOrphanedWorktreePathForThread([], ThreadId.make("missing-thread"));
    expect(result).toBeNull();
  });

  it("returns null when the target thread has no worktree", () => {
    const threads = [makeThread()];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBeNull();
  });

  it("returns the path when no other thread links to that worktree", () => {
    const threads = [makeThread({ worktreePath: "/tmp/repo/worktrees/feature-a" })];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBe("/tmp/repo/worktrees/feature-a");
  });

  it("returns null when another thread links to the same worktree", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBeNull();
  });

  it("ignores threads linked to different worktrees", () => {
    const threads = [
      makeThread({
        id: ThreadId.make("thread-1"),
        worktreePath: "/tmp/repo/worktrees/feature-a",
      }),
      makeThread({
        id: ThreadId.make("thread-2"),
        worktreePath: "/tmp/repo/worktrees/feature-b",
      }),
    ];
    const result = getOrphanedWorktreePathForThread(threads, ThreadId.make("thread-1"));
    expect(result).toBe("/tmp/repo/worktrees/feature-a");
  });
});

describe("getClientWorktreeCleanupPathForThread", () => {
  const ownedPath = "/tmp/repo/worktrees/temporary";
  const continuationPath = "/tmp/repo/worktrees/continuation";
  const keptThread = makeThread({
    temporary: false,
    keptAt: "2026-02-13T00:00:00.000Z",
    conversationPath: "/tmp/userdata/conversations/one",
    worktreePath: ownedPath,
    ownedWorktreePath: ownedPath,
  });

  it("leaves the current owned worktree to environment cleanup after Keep", () => {
    expect(getClientWorktreeCleanupPathForThread([keptThread], keptThread.id)).toBeNull();
  });

  it("offers normal cleanup for a new continuation worktree while retaining original directory ownership", () => {
    const continuation = makeThread({
      ...keptThread,
      id: ThreadId.make("continuation"),
      worktreePath: continuationPath,
    });
    expect(getClientWorktreeCleanupPathForThread([keptThread, continuation], continuation.id)).toBe(
      continuationPath,
    );
  });

  it("does not offer cleanup when another thread still uses the continuation worktree", () => {
    const continuation = makeThread({ ...keptThread, worktreePath: continuationPath });
    const sibling = makeThread({ id: ThreadId.make("sibling"), worktreePath: continuationPath });
    expect(
      getClientWorktreeCleanupPathForThread([continuation, sibling], continuation.id),
    ).toBeNull();
  });

  it("does not offer cleanup for a temporary thread", () => {
    const temporary = makeThread({ ...keptThread, temporary: true });
    expect(getClientWorktreeCleanupPathForThread([temporary], temporary.id)).toBeNull();
  });
});

describe("formatWorktreePathForDisplay", () => {
  it("shows only the last path segment for unix-like paths", () => {
    const result = formatWorktreePathForDisplay(
      "/Users/julius/.pathway/worktrees/pathway-mvp/pathway-4e609bb8",
    );
    expect(result).toBe("pathway-4e609bb8");
  });

  it("normalizes windows separators before selecting the final segment", () => {
    const result = formatWorktreePathForDisplay(
      "C:\\Users\\julius\\.pathway\\worktrees\\pathway-mvp\\pathway-4e609bb8",
    );
    expect(result).toBe("pathway-4e609bb8");
  });

  it("uses the final segment even when outside ~/.pathway/worktrees", () => {
    const result = formatWorktreePathForDisplay("/tmp/custom-worktrees/my-worktree");
    expect(result).toBe("my-worktree");
  });

  it("ignores trailing slashes", () => {
    const result = formatWorktreePathForDisplay("/tmp/custom-worktrees/my-worktree/");
    expect(result).toBe("my-worktree");
  });
});
