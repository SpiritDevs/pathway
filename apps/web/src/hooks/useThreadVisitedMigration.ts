import { parseScopedThreadKey } from "@spiritdevs/client-runtime/environment";
import { createElement, useCallback, useEffect, useState } from "react";
import type { ScopedThreadRef } from "@spiritdevs/contracts";

import { useThreadShell } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useUiStateStore } from "../uiStateStore";

const migratedThreadKeys = new Set<string>();

export function pendingThreadVisitedMigrations(
  watermarks: Readonly<Record<string, string>>,
  migrated: ReadonlySet<string>,
) {
  return Object.entries(watermarks).flatMap(([key, visitedAt]) => {
    const ref = parseScopedThreadKey(key);
    return ref !== null && !migrated.has(key) && Number.isFinite(Date.parse(visitedAt))
      ? [{ key, ref, visitedAt }]
      : [];
  });
}

function ThreadVisitedMigration({
  threadKey,
  threadRef,
  visitedAt,
  onComplete,
}: {
  threadKey: string;
  threadRef: ScopedThreadRef;
  visitedAt: string;
  onComplete: (key: string) => void;
}) {
  const thread = useThreadShell(threadRef);
  const visit = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  useEffect(() => {
    // Keep only outstanding watermarks subscribed while an environment loads
    // or upgrades from a server without visited tracking.
    if (thread === null || thread.lastVisitedAt === undefined) return;
    if (!migratedThreadKeys.has(threadKey)) {
      migratedThreadKeys.add(threadKey);
      const serverMs = thread.lastVisitedAt === null ? NaN : Date.parse(thread.lastVisitedAt);
      if (!Number.isFinite(serverMs) || serverMs < Date.parse(visitedAt)) {
        void visit({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId, visitedAt },
        });
      }
    }
    onComplete(threadKey);
  }, [thread, threadKey, threadRef, visitedAt, visit, onComplete]);
  return null;
}

/** Seeds server watermarks once, then unmounts each completed thread subscription. */
export function ThreadVisitedMigrationCoordinator() {
  const [pending, setPending] = useState(() =>
    pendingThreadVisitedMigrations(
      useUiStateStore.getState().threadLastVisitedAtById,
      migratedThreadKeys,
    ),
  );
  const onComplete = useCallback((key: string) => {
    setPending((current) => current.filter((entry) => entry.key !== key));
  }, []);
  return pending.map((entry) =>
    createElement(ThreadVisitedMigration, {
      key: entry.key,
      threadKey: entry.key,
      threadRef: entry.ref,
      visitedAt: entry.visitedAt,
      onComplete,
    }),
  );
}
