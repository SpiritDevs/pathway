import { HardDriveIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { ConversationStorage } from "../../hooks/useConversationStorage";
import { formatStorageBytes } from "../../lib/storagePresentation";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { Button } from "../ui/button";
import { Link } from "@tanstack/react-router";

export function conversationStorageBanner({
  storage,
  environmentLabel,
  chooseEnvironment,
}: {
  storage: ConversationStorage;
  environmentLabel: string;
  chooseEnvironment: ReactNode;
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
  if (!storage.isStartingConversation) return null;
  if (storage.running)
    return {
      id: "storage-cleanup-running",
      variant: "info",
      urgent: true,
      icon: <HardDriveIcon />,
      title: `Freeing space on ${environmentLabel}`,
      description:
        "Your draft is preserved. Cancellation stops before the next worktree and cannot restore removed files.",
      actions:
        storage.job?.status === "running" ? (
          <Button size="xs" variant="outline" onClick={() => void storage.cancelCleanup()}>
            Cancel cleanup
          </Button>
        ) : undefined,
    };
  if (storage.job) {
    const removed = storage.job.items.filter((item) => item.status === "removed");
    const failures = storage.job.items.filter(
      (item) => item.status === "failed" || item.status === "skipped",
    );
    const deltas = removed.flatMap((item) =>
      item.actualFreeDeltaBytes === null ? [] : [item.actualFreeDeltaBytes],
    );
    return {
      id: `storage-cleanup:${storage.job.id}`,
      variant: failures.length || storage.job.status === "failed" ? "warning" : "success",
      icon: <HardDriveIcon />,
      title: `${storage.job.status === "cancelled" ? "Cleanup cancelled" : "Cleanup finished"} on ${environmentLabel}`,
      description: (
        <>
          <p>
            {removed.length} worktrees removed.
            {deltas.length
              ? ` Available space changed by ${deltas.reduce((sum, delta) => sum + delta, 0) < 0 ? "−" : "+"}${formatStorageBytes(Math.abs(deltas.reduce((sum, delta) => sum + delta, 0)))}.`
              : ""}{" "}
            Your draft is ready for you to send.
          </p>
          {failures.length ? (
            <p>
              {failures.length} worktrees need attention. {failures[0]?.message}
            </p>
          ) : null}
          {storage.pressure === "critical" ? (
            <p>This environment is still critically low on storage.</p>
          ) : null}
        </>
      ),
      actions: (
        <div className="flex flex-wrap gap-1.5">
          {storage.pressure === "critical" && failures.some((item) => item.status === "failed") ? (
            <Button
              size="xs"
              variant="outline"
              disabled={storage.preview.isPending || !storage.preview.data}
              onClick={() => void storage.retryCleanup()}
            >
              Retry failed items
            </Button>
          ) : null}
          <Button size="xs" variant="outline" render={<Link to="/settings/archived" />}>
            Review cleanup
          </Button>
          {storage.pressure === "critical" ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                storage.allow();
                storage.dismissResult();
              }}
            >
              Continue anyway
            </Button>
          ) : null}
        </div>
      ),
      onDismiss: storage.dismissResult,
      dismissLabel: "Dismiss cleanup result",
    };
  }
  if (storage.pressure !== "critical" || storage.allowed) return null;
  const eligible = storage.preview.data?.items.filter((item) => item.eligible) ?? [];
  const blockers = [...new Set(storage.preview.data?.items.flatMap((item) => item.blockers) ?? [])];
  return {
    id: "storage-critical",
    variant: "warning",
    urgent: true,
    icon: <HardDriveIcon />,
    title: `${environmentLabel} is critically low on storage`,
    description: (
      <>
        <p>
          Free space before starting more work. Cleanup removes entire eligible worktrees, including
          ignored files, and preserves conversations and branches.
        </p>
        {storage.preview.isPending ? (
          <p>Checking how much space can be reclaimed...</p>
        ) : storage.preview.data ? (
          <p>
            {eligible.length
              ? `Up to approximately ${formatStorageBytes(storage.preview.data.estimatedBytes)} can be reclaimed. Cleanup stops when enough space is available.`
              : `No worktrees are currently eligible for cleanup.${blockers[0] ? ` ${blockers[0]}` : ""}`}
          </p>
        ) : null}
        {storage.error ? <p role="alert">{storage.error}</p> : null}
      </>
    ),
    actions: (
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="xs"
          variant="outline"
          disabled={
            storage.preview.isPending || storage.preview.error !== null || eligible.length === 0
          }
          onClick={() => void storage.cleanup()}
        >
          {eligible.length > 0
            ? `Free up ~${formatStorageBytes(storage.preview.data?.estimatedBytes)}`
            : "Clean up"}
        </Button>
        {chooseEnvironment}
        <Button size="xs" variant="ghost" onClick={storage.allow}>
          Continue anyway
        </Button>
      </div>
    ),
  };
}
