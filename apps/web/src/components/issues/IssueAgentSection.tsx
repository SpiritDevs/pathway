/**
 * The agent half of the properties rail: Start work, and the threads that came of it.
 *
 * Assigning an agent is intent, not a launch — the decision record is explicit that a stray kanban
 * drag must not spawn three agents — so the button here composes a prompt, opens a draft holding
 * it, and stops. The reader sends it.
 *
 * @module components/issues/IssueAgentSection
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { Issue, IssueThreadLink, ThreadId } from "@t3tools/contracts";
import { MessageSquareIcon, PlayIcon, XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { PROVIDER_CLIENT_DEFINITION_BY_VALUE } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

/** What the button says. The provider is named so a reassignment is visible without opening a menu. */
export function issueStartWorkLabel(issue: Issue): string | null {
  if (issue.assignee === null || issue.assignee.kind !== "agent") return null;
  const definition = PROVIDER_CLIENT_DEFINITION_BY_VALUE[issue.assignee.provider];
  return `Start work with ${definition?.label ?? issue.assignee.provider}`;
}

export function IssueAgentSection({
  issue,
  links,
  threadsById,
  starting,
  startWorkBlockReason,
  onStartWork,
  onOpenThread,
  onUnlinkThread,
}: {
  issue: Issue;
  /** Oldest first, as the server lists them: the first thread on an issue is the one that matters. */
  links: ReadonlyArray<IssueThreadLink>;
  /** Only threads on the environment the tracker lives on; anything else cannot be opened here. */
  threadsById: ReadonlyMap<ThreadId, EnvironmentThreadShell>;
  starting: boolean;
  /** Null when Start work can be pressed; otherwise the sentence explaining why not. */
  startWorkBlockReason: string | null;
  onStartWork: () => void;
  onOpenThread: (threadId: ThreadId) => void;
  onUnlinkThread: (threadId: ThreadId) => void;
}) {
  const startWorkLabel = issueStartWorkLabel(issue);
  if (startWorkLabel === null && links.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 border-t border-border/50 pt-3">
      {startWorkLabel === null ? null : (
        <Button
          className="w-full justify-start"
          disabled={starting || startWorkBlockReason !== null}
          onClick={onStartWork}
          size="sm"
          title={startWorkBlockReason ?? undefined}
          variant="outline"
        >
          {starting ? <Spinner className="size-3.5" /> : <PlayIcon />}
          <span className="truncate">{startWorkLabel}</span>
        </Button>
      )}

      {links.length === 0 ? null : (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Threads</span>
          <ul className="flex flex-col">
            {links.map((link) => {
              const thread = threadsById.get(link.threadId) ?? null;
              return (
                <li className="group/thread flex items-center gap-1" key={link.threadId}>
                  <button
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-start text-[13px] outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
                      thread === null && "text-muted-foreground",
                    )}
                    onClick={() => onOpenThread(link.threadId)}
                    title={
                      thread === null
                        ? "This thread is not on the connected environment."
                        : `Opened ${formatRelativeTimeLabel(link.createdAt)}`
                    }
                    type="button"
                  >
                    <MessageSquareIcon className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 truncate">
                      {/* The id, not "unknown": it is the only handle a reader has on a thread
                          this client cannot see, and it is what an unlink is aimed at. */}
                      {thread?.title ?? link.threadId}
                    </span>
                  </button>
                  <Button
                    aria-label="Unlink this thread"
                    className="shrink-0 text-muted-foreground opacity-0 group-hover/thread:opacity-100 focus-visible:opacity-100"
                    onClick={() => onUnlinkThread(link.threadId)}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <XIcon />
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
