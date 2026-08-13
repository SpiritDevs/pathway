/**
 * The agent half of the properties rail: Start work, and the threads that came of it.
 *
 * Assigning an agent is intent, not a launch — the decision record is explicit that a stray kanban
 * drag must not spawn three agents. The explicit button is different: it composes the issue
 * context and starts the first turn immediately.
 *
 * @module components/issues/IssueAgentSection
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  Issue,
  IssueThreadLink,
  ModelSelection,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { FolderIcon, GitBranchIcon, MessageSquareIcon, PlayIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "~/lib/utils";
import type { ProviderInstanceEntry } from "~/providerInstances";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import type { ModelEsque } from "../chat/providerIconUtils";
import { shouldRenderTraitsControls, TraitsPicker } from "../chat/TraitsPicker";
import { PROVIDER_CLIENT_DEFINITION_BY_VALUE } from "../settings/providerDriverMeta";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import type { IssueStartWorkWorkspaceMode } from "./issueStartWork.logic";

const ignorePromptChange = (_prompt: string): void => undefined;

/** What the button says. The provider is named so a reassignment is visible without opening a menu. */
export function issueStartWorkLabel(issue: Issue): string | null {
  if (issue.assignee === null || issue.assignee.kind !== "agent") return null;
  const definition = PROVIDER_CLIENT_DEFINITION_BY_VALUE[issue.assignee.provider];
  return `Start new thread with ${definition?.label ?? issue.assignee.provider}`;
}

function IssueStartWorkLauncher({
  issue,
  initialModelSelection,
  instanceEntries,
  modelOptionsByInstance,
  starting,
  startWorkBlockReason,
  currentBranch,
  newWorktreeBlockReason,
  onStartWork,
}: {
  issue: Issue;
  initialModelSelection: ModelSelection | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  starting: boolean;
  startWorkBlockReason: string | null;
  currentBranch: string | null;
  newWorktreeBlockReason: string | null;
  onStartWork: (modelSelection: ModelSelection, workspaceMode: IssueStartWorkWorkspaceMode) => void;
}) {
  const [modelSelection, setModelSelection] = useState(initialModelSelection);
  const [workspaceMode, setWorkspaceMode] =
    useState<IssueStartWorkWorkspaceMode>("current_checkout");
  const activeEntry =
    instanceEntries.find((entry) => entry.instanceId === modelSelection?.instanceId) ?? null;
  const hasTraits =
    activeEntry !== null &&
    modelSelection !== null &&
    shouldRenderTraitsControls({
      provider: activeEntry.driverKind,
      models: activeEntry.models,
      model: modelSelection.model,
      prompt: "",
      modelOptions: modelSelection.options,
      allowPromptInjectedEffort: false,
    });
  const startWorkLabel = issueStartWorkLabel(issue) ?? "Start work";
  const providerLabel =
    issue.assignee?.kind === "agent"
      ? (PROVIDER_CLIENT_DEFINITION_BY_VALUE[issue.assignee.provider]?.label ??
        issue.assignee.provider)
      : "assigned agent";
  const blockReason =
    startWorkBlockReason ??
    (workspaceMode === "new_worktree" ? newWorktreeBlockReason : null) ??
    (modelSelection === null || activeEntry === null
      ? `No available ${providerLabel} model can start this work.`
      : null);

  return (
    <div className="flex flex-col gap-2">
      {modelSelection === null || activeEntry === null ? null : (
        <div className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1.5">
          <span className="text-[11px] text-muted-foreground">Model</span>
          <ProviderModelPicker
            activeInstanceId={modelSelection.instanceId}
            disabled={starting}
            instanceEntries={instanceEntries}
            lockedProvider={activeEntry.driverKind}
            model={modelSelection.model}
            modelOptionsByInstance={modelOptionsByInstance}
            onInstanceModelChange={(instanceId, model) => {
              setModelSelection(createModelSelection(instanceId, model));
            }}
            triggerAriaLabel={`Model for starting work on ${issue.key}`}
            triggerClassName="w-full max-w-none shrink text-foreground/90 hover:text-foreground"
            triggerVariant="outline"
          />

          {hasTraits ? (
            <>
              <span className="text-[11px] text-muted-foreground">Reasoning</span>
              <div aria-label={`Reasoning and model options for ${issue.key}`}>
                <TraitsPicker
                  allowPromptInjectedEffort={false}
                  model={modelSelection.model}
                  modelOptions={modelSelection.options}
                  models={activeEntry.models}
                  onModelOptionsChange={(nextOptions) => {
                    setModelSelection((current) =>
                      current === null
                        ? null
                        : createModelSelection(current.instanceId, current.model, nextOptions),
                    );
                  }}
                  onPromptChange={ignorePromptChange}
                  prompt=""
                  provider={activeEntry.driverKind}
                  triggerClassName="w-full max-w-none shrink justify-between text-foreground/90 hover:text-foreground"
                  triggerVariant="outline"
                />
              </div>
            </>
          ) : null}

          <span className="text-[11px] text-muted-foreground">Workspace</span>
          <Select
            disabled={starting}
            onValueChange={(value) => setWorkspaceMode(value as IssueStartWorkWorkspaceMode)}
            value={workspaceMode}
          >
            <SelectTrigger
              aria-label={`Workspace for starting work on ${issue.key}`}
              className="w-full min-w-0 text-foreground/90"
              size="sm"
            >
              <SelectValue>
                {workspaceMode === "new_worktree" ? "New branch" : "Current checkout"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup className="w-72">
              <SelectItem value="current_checkout">
                <span className="flex items-start gap-2">
                  <FolderIcon className="mt-0.5 size-4" />
                  <span className="flex min-w-0 flex-col">
                    <span>
                      Current checkout{currentBranch === null ? "" : ` (${currentBranch})`}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      Start a new thread in the project's main workspace.
                    </span>
                  </span>
                </span>
              </SelectItem>
              <SelectItem
                disabled={newWorktreeBlockReason !== null}
                title={newWorktreeBlockReason ?? undefined}
                value="new_worktree"
              >
                <span className="flex items-start gap-2">
                  <GitBranchIcon className="mt-0.5 size-4" />
                  <span className="flex min-w-0 flex-col">
                    <span>New branch</span>
                    <span className="text-xs text-muted-foreground">
                      Create an isolated worktree and run its setup tasks.
                    </span>
                  </span>
                </span>
              </SelectItem>
            </SelectPopup>
          </Select>
        </div>
      )}

      <Button
        className="w-full justify-start"
        disabled={starting || blockReason !== null}
        onClick={() => {
          if (modelSelection !== null) onStartWork(modelSelection, workspaceMode);
        }}
        size="sm"
        title={blockReason ?? undefined}
        variant="outline"
      >
        {starting ? <Spinner className="size-3.5" /> : <PlayIcon />}
        <span className="truncate">{startWorkLabel}</span>
      </Button>
    </div>
  );
}

export function IssueAgentSection({
  issue,
  initialModelSelection,
  instanceEntries,
  links,
  modelOptionsByInstance,
  threadsById,
  starting,
  startWorkBlockReason,
  currentBranch,
  newWorktreeBlockReason,
  onStartWork,
  onOpenThread,
  onUnlinkThread,
}: {
  issue: Issue;
  initialModelSelection: ModelSelection | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  /** Oldest first, as the server lists them: the first thread on an issue is the one that matters. */
  links: ReadonlyArray<IssueThreadLink>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  /** Only threads on the environment the tracker lives on; anything else cannot be opened here. */
  threadsById: ReadonlyMap<ThreadId, EnvironmentThreadShell>;
  starting: boolean;
  /** Null when Start work can be pressed; otherwise the sentence explaining why not. */
  startWorkBlockReason: string | null;
  currentBranch: string | null;
  /** Null when a branch can be created; otherwise shown on the disabled workspace option. */
  newWorktreeBlockReason: string | null;
  onStartWork: (modelSelection: ModelSelection, workspaceMode: IssueStartWorkWorkspaceMode) => void;
  onOpenThread: (threadId: ThreadId) => void;
  onUnlinkThread: (threadId: ThreadId) => void;
}) {
  const startWorkLabel = issueStartWorkLabel(issue);
  if (startWorkLabel === null && links.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 border-t border-border/50 pt-3">
      {startWorkLabel === null ? null : (
        <IssueStartWorkLauncher
          initialModelSelection={initialModelSelection}
          instanceEntries={instanceEntries}
          issue={issue}
          key={`${issue.assignee?.kind === "agent" ? issue.assignee.provider : "none"}:${initialModelSelection?.instanceId ?? "none"}:${initialModelSelection?.model ?? "none"}:${JSON.stringify(initialModelSelection?.options ?? [])}`}
          modelOptionsByInstance={modelOptionsByInstance}
          currentBranch={currentBranch}
          newWorktreeBlockReason={newWorktreeBlockReason}
          onStartWork={onStartWork}
          starting={starting}
          startWorkBlockReason={startWorkBlockReason}
        />
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
