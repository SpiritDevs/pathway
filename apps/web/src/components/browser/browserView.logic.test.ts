import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { browserThreadOptions, resolveBrowserThreadOption } from "./browserView.logic";

function thread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    environmentId: "env-1" as EnvironmentId,
    id: id as ThreadId,
    projectId: "project-1" as ProjectId,
    title: `Thread ${id}`,
    providerInstanceId: "codex" as ProviderInstanceId,
    modelSelection: {
      instanceId: "codex" as ProviderInstanceId,
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    lineage: {
      rootThreadId: id as ThreadId,
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    activeProviderThreadId: null,
    latestRun: null,
    runtime: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    deletedAt: null,
    source: {} as EnvironmentThreadShell["source"],
    ...overrides,
  };
}

describe("browserThreadOptions", () => {
  it("puts open browser sessions first, then the most recent threads", () => {
    const options = browserThreadOptions(
      [
        thread("recent", { updatedAt: "2026-08-16T02:00:00.000Z" }),
        thread("browser", { updatedAt: "2026-08-14T02:00:00.000Z" }),
        thread("older", { updatedAt: "2026-08-13T02:00:00.000Z" }),
      ],
      new Set(["env-1:browser"]),
    );

    expect(options.map(({ threadId }) => threadId)).toEqual(["browser", "recent", "older"]);
  });

  it("excludes archived and deleted threads", () => {
    expect(
      browserThreadOptions(
        [
          thread("active"),
          thread("archived", { archivedAt: "2026-08-16T00:00:00.000Z" }),
          thread("deleted", { deletedAt: "2026-08-16T00:00:00.000Z" }),
        ],
        new Set(),
      ).map(({ threadId }) => threadId),
    ).toEqual(["active"]);
  });
});

describe("resolveBrowserThreadOption", () => {
  it("keeps a valid preference and falls back to the first option", () => {
    const options = browserThreadOptions(
      [thread("first"), thread("second", { updatedAt: "2026-08-16T00:00:00.000Z" })],
      new Set(),
    );
    expect(resolveBrowserThreadOption(options, "env-1:second")?.threadId).toBe("second");
    expect(resolveBrowserThreadOption(options, "missing")?.threadId).toBe("second");
    expect(resolveBrowserThreadOption([], "missing")).toBeNull();
  });
});
