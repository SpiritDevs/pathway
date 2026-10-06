import { scopeThreadRef, scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@spiritdevs/contracts";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  pendingThreadVisitedMigrations,
  ThreadVisitedMigrationCoordinator,
} from "./useThreadVisitedMigration";

const migration = vi.hoisted(() => ({
  watermarks: {} as Record<string, string>,
  shells: new Map<string, { lastVisitedAt?: string | null }>(),
  subscriptions: new Set<string>(),
  visit: vi.fn(async () => undefined),
}));
vi.mock("../uiStateStore", () => ({
  useUiStateStore: { getState: () => ({ threadLastVisitedAtById: migration.watermarks }) },
}));
vi.mock("../state/threads", () => ({ threadEnvironment: { visit: "visit-command" } }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => migration.visit }));
vi.mock("../state/entities", async () => {
  const { useEffect } = await import("react");
  return {
    useThreadShell: (ref: ScopedThreadRef) => {
      const threadKey = scopedThreadKey(ref);
      useEffect(() => {
        migration.subscriptions.add(threadKey);
        return () => {
          migration.subscriptions.delete(threadKey);
        };
      }, [threadKey]);
      return migration.shells.get(threadKey) ?? null;
    },
  };
});

const key = (id: string) =>
  scopedThreadKey(scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make(id)));

describe("visited migration worklist", () => {
  it("subscribes only to valid, unmigrated local watermarks", () => {
    const visitedAt = "2026-10-07T00:00:00Z";
    const pending = pendingThreadVisitedMigrations(
      {
        [key("pending")]: visitedAt,
        [key("done")]: visitedAt,
        [key("invalid")]: "invalid",
        invalidKey: visitedAt,
      },
      new Set([key("done")]),
    );
    expect(pending).toEqual([
      {
        key: key("pending"),
        ref: scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("pending")),
        visitedAt,
      },
    ]);
    expect(pendingThreadVisitedMigrations({}, new Set())).toEqual([]);
  });

  it("waits for supported shells, preserves newer server visits and releases completed subscriptions", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const visitedAt = "2026-10-07T00:00:00Z";
    const loading = key("loading-shell");
    const legacy = key("legacy-shell");
    const newer = key("newer-server-visit");
    migration.watermarks = { [loading]: visitedAt, [legacy]: visitedAt, [newer]: visitedAt };
    migration.shells.set(legacy, {});
    migration.shells.set(newer, { lastVisitedAt: "2026-10-07T01:00:00Z" });
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(createElement(ThreadVisitedMigrationCoordinator));
      });
      expect(migration.subscriptions).toEqual(new Set([loading, legacy]));
      expect(migration.visit).not.toHaveBeenCalled();
      migration.shells.set(loading, { lastVisitedAt: null });
      await act(async () => {
        renderer!.update(createElement(ThreadVisitedMigrationCoordinator));
      });
      expect(migration.visit).toHaveBeenCalledExactlyOnceWith({
        environmentId: EnvironmentId.make("environment"),
        input: { threadId: ThreadId.make("loading-shell"), visitedAt },
      });
      expect(migration.subscriptions).toEqual(new Set([legacy]));
      migration.shells.set(legacy, { lastVisitedAt: visitedAt });
      await act(async () => {
        renderer!.update(createElement(ThreadVisitedMigrationCoordinator));
      });
      expect(migration.subscriptions.size).toBe(0);
      expect(migration.visit).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        renderer?.unmount();
      });
      vi.unstubAllGlobals();
    }
  });
});
