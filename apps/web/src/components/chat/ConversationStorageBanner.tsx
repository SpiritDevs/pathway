import { HardDriveIcon } from "lucide-react";
import type { ConversationStorage } from "../../hooks/useConversationStorage";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { Button } from "../ui/button";
import { Link } from "@tanstack/react-router";

export function conversationStorageBanner({
  storage,
  environmentLabel,
  hasMessages,
}: {
  storage: Pick<
    ConversationStorage,
    "reclaimed" | "error" | "running" | "recreateWorktree" | "pressure" | "allowed" | "allow"
  >;
  environmentLabel: string;
  hasMessages: boolean;
}): ComposerBannerStackItem | null {
  if (storage.reclaimed)
    return {
      id: "storage-reclaimed",
      variant: "info",
      icon: <HardDriveIcon />,
      title: "Worktree removed to free space",
      description: (
        <>
          <p>
            Your conversation and branch are preserved. Recreate the worktree before continuing.
            Dependencies and generated files may need rebuilding.
          </p>
          {storage.error ? <p role="alert">{storage.error}</p> : null}
        </>
      ),
      actions: (
        <Button
          size="xs"
          variant="outline"
          disabled={storage.running}
          onClick={() => void storage.recreateWorktree()}
        >
          {storage.running ? "Recreating..." : "Recreate worktree"}
        </Button>
      ),
    };
  if (!storage.isStartingConversation || hasMessages || storage.pressure !== "critical" || storage.allowed) return null;
  return {
    id: "storage-critical",
    variant: "warning",
    presentation: "lip",
    icon: <HardDriveIcon />,
    title: (
      <span className="block truncate" title={`${environmentLabel} - Critical Storage`}>
        {environmentLabel} - Critical Storage
      </span>
    ),
    actions: (
      <Button size="xs" variant="outline" render={<Link to="/settings/archived" />}>
        Cleanup
      </Button>
    ),
    onDismiss: storage.allow,
    dismissLabel: "Dismiss storage warning",
  };
}
