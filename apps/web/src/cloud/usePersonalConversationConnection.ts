import { useEffect } from "react";
import { useAtomValue } from "@effect/atom-react";
import { RelayConnectionRegistration, RelayConnectionTarget } from "@spiritdevs/client-runtime/connection";
import type { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import { environmentCatalog } from "~/connection/catalog";
import { useAtomCommand } from "~/state/use-atom-command";
import { personalConversationsAtom } from "./conversationSharing";

/** Registers a shared environment lazily when its conversation is opened. */
export function usePersonalConversationConnection(environmentId: EnvironmentId | null, threadId: ThreadId | null) {
  const conversations = useAtomValue(personalConversationsAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const register = useAtomCommand(environmentCatalog.register);
  const shared = conversations.find(row => row.environmentId === environmentId && row.threadId === threadId && row.shareId !== null);
  useEffect(() => {
    if (shared === undefined || shared.shareId === null || catalog.entries.has(shared.environmentId)) return;
    void register(new RelayConnectionRegistration({ target: new RelayConnectionTarget({
      environmentId: shared.environmentId,
      label: "Shared conversations",
      conversationShareId: shared.shareId,
    }) }));
  }, [catalog, register, shared]);
}
