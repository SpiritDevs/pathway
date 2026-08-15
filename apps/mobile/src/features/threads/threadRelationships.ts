import type { OrchestrationV2ThreadShell, ThreadId } from "@spiritdevs/contracts";

/** Archived snapshots may lag the live stream. Live shells win for duplicate ids. */
export function mergeRelationshipThreadShells(
  live: ReadonlyArray<OrchestrationV2ThreadShell>,
  archived: ReadonlyArray<OrchestrationV2ThreadShell>,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  const byThreadId = new Map<ThreadId, OrchestrationV2ThreadShell>();
  for (const thread of archived) byThreadId.set(thread.id, thread);
  for (const thread of live) byThreadId.set(thread.id, thread);
  return [...byThreadId.values()];
}
