// @effect-diagnostics nodeBuiltinImport:off -- Pure path derivation is shared by creation and cleanup validation.
import { join } from "node:path";

/** Stable owned directory; provider ids cannot introduce path segments. */
export function conversationDirectoryForThread(stateDir: string, threadId: string): string {
  return join(stateDir, "conversations", `thread-${encodeURIComponent(threadId)}`);
}
