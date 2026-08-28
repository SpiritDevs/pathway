import {
  type ChatAttachment,
  type EnvironmentId,
  isProviderDriverKind,
  ProjectId,
  type ModelSelection,
  type MessageId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ProjectedTurnItem,
  type ProviderDriverKind,
  type ServerProvider,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
  type RunId,
} from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import { presentThreadShell } from "@spiritdevs/client-runtime/state/shell";
import { modelSelectionsEqual } from "@spiritdevs/shared/model";
import { resolveThreadForkKind } from "@spiritdevs/client-runtime/state/thread-relationships";
import { type ChatMessage, type SessionPhase, type Thread } from "../types";
import { type ComposerAttachment, type DraftThreadState } from "../composerDraftStore";
import * as Schema from "effect/Schema";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadShells } from "../state/threads";
import { waitForAtomValue } from "../state/waitForAtomValue";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import type { DraftThreadEnvMode } from "../composerDraftStore";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "pathway:last-invoked-script-by-project";
export const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;
export const MAX_HIDDEN_MOUNTED_PREVIEW_THREADS = 3;
export const ENVIRONMENT_RECONNECT_WARNING_GRACE_MS = 2_000;
export const FORK_THREAD_READINESS_ERROR =
  "The fork was created, but its thread data did not reach this client. Reconnect and try opening it from the sidebar.";

export type ChatShortcutScope = "page" | "side-chat";

export function visibleTurnItemsForThreadPresentation(
  thread: Pick<Thread, "forkKind" | "lineage" | "title"> | null,
  rows: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlyArray<OrchestrationV2ProjectedTurnItem> {
  if (thread === null || resolveThreadForkKind(thread) !== "side_chat") return rows;
  return rows.filter((row) => row.visibility !== "inherited");
}

export function shortcutScopeOwnsEvent(
  scope: ChatShortcutScope,
  eventFromSideChat: boolean,
): boolean {
  return (scope === "side-chat") === eventFromSideChat;
}

export function resolvePanelSurfaceOwnerThreadRef(
  activeThreadRef: ScopedThreadRef | null,
  panelOwnerThreadRef?: ScopedThreadRef,
): ScopedThreadRef | null {
  return panelOwnerThreadRef ?? activeThreadRef;
}

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function scheduleEnvironmentReconnectWarning(showWarning: () => void): () => void {
  const timeoutId = globalThis.setTimeout(showWarning, ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);
  return () => globalThis.clearTimeout(timeoutId);
}

export function hasEnvironmentReconnectWarningGraceElapsed(
  activeEnvironmentId: EnvironmentId | null,
  elapsedEnvironmentId: EnvironmentId | null,
): boolean {
  return activeEnvironmentId !== null && activeEnvironmentId === elapsedEnvironmentId;
}

export function startNewThreadForProject(
  projectRef: ScopedProjectRef | null,
  handleNewThread: (projectRef: ScopedProjectRef) => Promise<unknown>,
): boolean {
  if (projectRef === null) return false;
  void handleNewThread(projectRef);

  return true;
}

/**
 * Wait until the newly forked thread is visible in this client before opening
 * it beside its parent. Keeping readiness and presentation in one operation
 * prevents a successful server command from opening an empty side chat while
 * the shell is still in flight (especially over remote connections).
 */
export async function openForkedThreadSideChatWhenReady(input: {
  readonly parentThreadRef: ScopedThreadRef;
  readonly targetThreadRef: ScopedThreadRef;
  readonly waitForThreadShell: (ref: ScopedThreadRef) => Promise<boolean>;
  readonly openThread: (parentRef: ScopedThreadRef, childThreadId: ThreadId) => void;
  readonly onThreadUnavailable: (message: string) => void;
}): Promise<boolean> {
  const targetThreadReady = await input.waitForThreadShell(input.targetThreadRef);
  if (!targetThreadReady) {
    input.onThreadUnavailable(FORK_THREAD_READINESS_ERROR);
    return false;
  }

  input.openThread(input.parentThreadRef, input.targetThreadRef.threadId);
  return true;
}

export function resolveThreadMetadataUpdateForNextTurn(input: {
  currentModelSelection: ModelSelection;
  nextModelSelection?: ModelSelection;
  currentBranch: string | null;
  nextBranch?: string;
}): {
  modelSelection?: ModelSelection;
  branch?: string;
  worktreePath?: null;
} | null {
  const nextModelSelection = input.nextModelSelection;
  const modelSelectionChanged =
    nextModelSelection !== undefined &&
    (nextModelSelection.model !== input.currentModelSelection.model ||
      nextModelSelection.instanceId !== input.currentModelSelection.instanceId ||
      JSON.stringify(nextModelSelection.options ?? null) !==
        JSON.stringify(input.currentModelSelection.options ?? null));
  const branchChanged = input.nextBranch !== undefined && input.nextBranch !== input.currentBranch;
  if (!modelSelectionChanged && !branchChanged) {
    return null;
  }
  return {
    ...(modelSelectionChanged ? { modelSelection: nextModelSelection } : {}),
    ...(branchChanged ? { branch: input.nextBranch, worktreePath: null } : {}),
  };
}

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
): Thread {
  const timestamp = DateTime.makeUnsafe(draftThread.createdAt);
  return presentThreadShell(draftThread.environmentId, {
    id: threadId,
    projectId: draftThread.projectId,
    title: "New thread",
    providerInstanceId: fallbackModelSelection.instanceId,
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    locations: draftThread.locations,
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: null,
    activeRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  });
}

export function shouldWriteThreadErrorToCurrentServerThread(input: {
  serverThread:
    | {
        environmentId: EnvironmentId;
        id: ThreadId;
      }
    | null
    | undefined;
  routeThreadRef: ScopedThreadRef;
  targetThreadId: ThreadId;
}): boolean {
  return Boolean(
    input.serverThread &&
    input.targetThreadId === input.routeThreadRef.threadId &&
    input.serverThread.environmentId === input.routeThreadRef.environmentId &&
    input.serverThread.id === input.targetThreadId,
  );
}

export function reconcileMountedTerminalThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadTerminalOpen: boolean;
  maxHiddenThreadCount?: number;
}): string[] {
  return reconcileRetainedMountedThreadIds({
    currentThreadIds: input.currentThreadIds,
    openThreadIds: input.openThreadIds,
    activeThreadId: input.activeThreadId,
    activeThreadOpen: input.activeThreadTerminalOpen,
    maxHiddenThreadCount: input.maxHiddenThreadCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  });
}

export function reconcileRetainedMountedThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadOpen: boolean;
  maxHiddenThreadCount: number;
  retainInactiveActiveThread?: boolean;
}): string[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) =>
      (threadId !== input.activeThreadId || input.retainInactiveActiveThread === true) &&
      openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(0, input.maxHiddenThreadCount);
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (attachment.type !== "image") continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export function resolveEditableV2UserMessageId(
  projection: OrchestrationV2ThreadProjection | null | undefined,
): MessageId | null {
  if (!projection) return null;
  const latestUserItem = projection.visibleTurnItems.findLast(
    (row) => row.item.type === "user_message",
  )?.item;
  if (latestUserItem?.type !== "user_message" || latestUserItem.createdBy !== "user") return null;
  const run = projection.runs.find((candidate) => candidate.id === latestUserItem.runId);
  if (run === undefined || run.status === "queued" || run.status === "cancelled") return null;
  if (!modelSelectionsEqual(projection.thread.modelSelection, run.modelSelection)) return null;
  const hasChangesAfterMessage = projection.checkpoints.some(
    (checkpoint) =>
      checkpoint.status === "ready" &&
      checkpoint.files.length > 0 &&
      checkpoint.appRunOrdinal !== null &&
      checkpoint.appRunOrdinal >= run.ordinal,
  );
  if (hasChangesAfterMessage) return null;
  const attempt = projection.attempts.find((candidate) => candidate.id === run.activeAttemptId);
  const providerTurn = projection.providerTurns.find(
    (candidate) =>
      candidate.runAttemptId === run.activeAttemptId || candidate.id === attempt?.providerTurnId,
  );
  const hasAssistantMessage = projection.messages.some(
    (message) => message.runId === run.id && message.role === "assistant",
  );
  if (run.status === "interrupted" && providerTurn === undefined && !hasAssistantMessage) {
    return latestUserItem.messageId;
  }
  const providerThread = projection.providerThreads.find(
    (candidate) => candidate.id === run.providerThreadId,
  );
  const providerSession = projection.providerSessions.find(
    (candidate) => candidate.id === providerThread?.providerSessionId,
  );
  if (providerSession?.capabilities.checkpointing.providerCanRollbackConversation !== true) {
    return null;
  }
  const firstRunScope = projection.checkpointScopes.find(
    (scope) => scope.runId === run.id && scope.kind === "root_run",
  );
  const hasBaseline = projection.checkpoints.some(
    (checkpoint) =>
      checkpoint.status === "ready" &&
      (run.ordinal === 1
        ? firstRunScope !== undefined &&
          checkpoint.scopeId === firstRunScope.id &&
          checkpoint.ordinalWithinScope === 0 &&
          checkpoint.appRunOrdinal === null
        : checkpoint.appRunOrdinal === run.ordinal - 1),
  );
  return hasBaseline ? latestUserItem.messageId : null;
}

export function resolveRetryableV2UserMessageId(
  projection: OrchestrationV2ThreadProjection | null | undefined,
): MessageId | null {
  const editableMessageId = resolveEditableV2UserMessageId(projection);
  if (editableMessageId === null || !projection) return null;
  const latestUserItem = projection.visibleTurnItems.findLast(
    (row) => row.item.type === "user_message",
  )?.item;
  if (latestUserItem?.type !== "user_message" || latestUserItem.messageId !== editableMessageId) {
    return null;
  }
  const run = projection.runs.find((candidate) => candidate.id === latestUserItem.runId);
  return run?.status === "failed" ? editableMessageId : null;
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read attachment data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read attachment."));
    });
    reader.readAsDataURL(file);
  });
}

/** Downloads durable queued attachments into composer-owned files and previews. */
export async function loadQueuedComposerImages(
  attachments: ReadonlyArray<{
    readonly attachment: ChatAttachment;
    readonly url: string;
  }>,
): Promise<ComposerAttachment[]> {
  const images: ComposerAttachment[] = [];
  try {
    for (const { attachment, url } of attachments) {
      if (attachment.type !== "image" && attachment.type !== "file") continue;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Could not load ${attachment.name}.`);
      }
      const file = new File([await response.blob()], attachment.name, {
        type: attachment.mimeType,
      });
      images.push(
        attachment.type === "image"
          ? {
              type: "image",
              id: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
              file,
              previewUrl: URL.createObjectURL(file),
            }
          : {
              type: "file",
              id: attachment.id,
              name: attachment.name,
              mimeType: attachment.mimeType,
              sizeBytes: attachment.sizeBytes,
              file,
              previewUrl: "",
            },
      );
    }
    return images;
  } catch (error) {
    for (const image of images) {
      revokeBlobPreviewUrl(image.previewUrl);
    }
    throw error;
  }
}

export function resolveSendEnvMode(input: {
  requestedEnvMode: DraftThreadEnvMode;
  isGitRepo: boolean;
}): DraftThreadEnvMode {
  return input.isGitRepo ? input.requestedEnvMode : "local";
}

export function shouldShowComposerContextStrip(input: {
  isDraftHeroState: boolean;
  isGitRepo: boolean;
  hasActiveProject: boolean;
  persistInActiveThreads: boolean;
}): boolean {
  return (
    input.isGitRepo &&
    input.hasActiveProject &&
    (input.isDraftHeroState || input.persistInActiveThreads)
  );
}

export function cloneComposerAttachmentForRetry(image: ComposerAttachment): ComposerAttachment {
  if (typeof URL === "undefined" || image.file === null || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  /**
   * Optional element-pick attachment count. Element contexts contribute to
   * "sendable content" exactly like images and (text-bearing) terminal
   * contexts do: a prompt of just element chips is still a valid send.
   */
  elementContextCount?: number;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  const elementContextCount = options.elementContextCount ?? 0;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 ||
      options.imageCount > 0 ||
      sendableTerminalContexts.length > 0 ||
      elementContextCount > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

export function branchMismatchKey(
  threadId: string | null,
  mismatch: { threadBranch: string; currentBranch: string } | null,
): string | null {
  if (!threadId || !mismatch) {
    return null;
  }
  return `${threadId}:${mismatch.threadBranch}:${mismatch.currentBranch}`;
}

// The mismatch banner only matters when the user is about to send: passive
// reading of an old thread carries no risk (the branch picker tint already
// covers ambient awareness). Draft content is the intent signal — composer
// focus is useless here because ChatView autofocuses the composer on every
// thread open. `wasShownForCurrentMismatch` keeps the banner mounted once
// revealed so it doesn't flicker away when the draft is cleared.
export function shouldShowBranchMismatchBanner(input: {
  hasMismatch: boolean;
  isDismissed: boolean;
  composerHasContent: boolean;
  wasShownForCurrentMismatch: boolean;
}): boolean {
  if (!input.hasMismatch || input.isDismissed) {
    return false;
  }
  return input.composerHasContent || input.wasShownForCurrentMismatch;
}

// Session-scoped (module-level so it survives ChatView remounts, e.g. route
// changes). Durable cross-device dismissal is planned as a server-side ack.
const sessionDismissedBranchMismatchKeys = new Set<string>();

export function dismissBranchMismatchForSession(key: string): void {
  sessionDismissedBranchMismatchKeys.add(key);
}

export function isBranchMismatchDismissedForSession(key: string | null): boolean {
  return key !== null && sessionDismissedBranchMismatchKeys.has(key);
}

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(thread && (thread.latestRun !== null || thread.itemCount > 0 || thread.runtime));
}

export function threadProjectionIsPending(
  thread: Thread | null | undefined,
  projectionAvailable: boolean,
): boolean {
  return !projectionAvailable && threadHasStarted(thread);
}

export function resolveThreadProjectionWorkingPresentation(input: {
  projectionPending: boolean;
  isWorking: boolean;
  latestRun: Thread["latestRun"];
}):
  | "activity"
  | "connecting"
  | "connecting-complete"
  | "connecting-settled"
  | "connecting-neutral" {
  if (!input.projectionPending) return "activity";
  if (input.isWorking) return "connecting";
  switch (input.latestRun?.status) {
    case "completed":
      return "connecting-complete";
    case "failed":
    case "cancelled":
    case "interrupted":
    case "rolled_back":
      return "connecting-settled";
    case undefined:
      return "connecting-neutral";
    default:
      return "connecting";
  }
}

// A live runtime carries its provider driver directly. Settled threads no
// longer have that runtime, so their persisted instance selection must be
// resolved through the current provider catalogue before it can become a
// driver lock. Instance and driver ids share the same open slug syntax; never
// infer one brand from the other or a custom id such as `codex_work` will lock
// the composer to a nonexistent driver after the thread settles.
export function deriveLockedProvider(input: {
  thread: Thread | null | undefined;
  selectedProvider: string | null;
  threadProvider: string | null;
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>;
}): ProviderDriverKind | null {
  if (!threadHasStarted(input.thread)) {
    return null;
  }
  const sessionProvider = input.thread?.runtime?.providerName ?? null;
  if (sessionProvider && isProviderDriverKind(sessionProvider)) {
    return sessionProvider;
  }
  const resolveDriver = (selection: string | null): ProviderDriverKind | null => {
    if (!selection) return null;
    const instance = input.providers.find((provider) => provider.instanceId === selection);
    if (instance) return instance.driver;
    return input.providers.find((provider) => provider.driver === selection)?.driver ?? null;
  };
  return resolveDriver(input.threadProvider) ?? resolveDriver(input.selectedProvider);
}

export function getStartedThreadModelChangeBlockReason(input: {
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "requiresNewThreadForModelChange">>;
  hasStartedSession: boolean;
  supportsProviderSwitchingViaHandoff?: boolean;
  currentModelSelection: ModelSelection;
  currentProviderInstanceId?: ModelSelection["instanceId"] | null | undefined;
  nextModelSelection: ModelSelection;
}): { title: string; description: string } | null {
  if (!input.hasStartedSession) {
    return null;
  }
  const currentModelSelection = {
    ...input.currentModelSelection,
    instanceId: input.currentProviderInstanceId ?? input.currentModelSelection.instanceId,
  };
  if (
    currentModelSelection.instanceId === input.nextModelSelection.instanceId &&
    currentModelSelection.model === input.nextModelSelection.model
  ) {
    return null;
  }
  if (currentModelSelection.instanceId !== input.nextModelSelection.instanceId) {
    if (input.supportsProviderSwitchingViaHandoff === true) {
      return null;
    }
    return {
      title: "Start a new chat to switch providers",
      description: "This thread does not support switching providers after it has started.",
    };
  }
  const currentProvider = input.providers.find(
    (snapshot) => snapshot.instanceId === currentModelSelection.instanceId,
  );
  const nextProvider = input.providers.find(
    (snapshot) => snapshot.instanceId === input.nextModelSelection.instanceId,
  );
  if (
    currentProvider?.requiresNewThreadForModelChange !== true &&
    nextProvider?.requiresNewThreadForModelChange !== true
  ) {
    return null;
  }
  return {
    title: "Start a new chat to change models",
    description: "This provider does not allow switching models after a conversation has started.",
  };
}

export async function waitForStartedServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  const threadAtom = environmentThreadShells.threadShellAtom(threadRef);
  return waitForAtomValue({
    registry: appAtomRegistry,
    atom: threadAtom,
    predicate: threadHasStarted,
    timeoutMs,
  });
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  latestUserMessageId: ChatMessage["id"] | null;
  latestRunId: RunId | null;
  latestRunRequestedAt: string | null;
  latestRunStartedAt: string | null;
  latestRunCompletedAt: string | null;
  runtimeStatus: NonNullable<Thread["runtime"]>["status"] | null;
  runtimeUpdatedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: { preparingWorktree?: boolean; latestUserMessageId?: ChatMessage["id"] | null },
): LocalDispatchSnapshot {
  const latestRun = activeThread?.latestRun ?? null;
  const runtime = activeThread?.runtime ?? null;
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    latestUserMessageId: options?.latestUserMessageId ?? null,
    latestRunId: latestRun?.runId ?? null,
    latestRunRequestedAt: latestRun?.requestedAt ?? null,
    latestRunStartedAt: latestRun?.startedAt ?? null,
    latestRunCompletedAt: latestRun?.completedAt ?? null,
    runtimeStatus: runtime?.status ?? null,
    runtimeUpdatedAt: runtime?.updatedAt ?? null,
  };
}

/**
 * The timeline renders committed user rows from `visibleTurnItems`, but
 * `message.updated` can land in `projection.messages` one event earlier than
 * the matching `turn-item.updated`. Basing optimistic eviction on visible user
 * turn items avoids dropping steer rows in that gap.
 */
export function deriveCommittedServerUserMessageIds(
  visibleTurnItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
): ReadonlySet<ChatMessage["id"]> {
  return new Set(
    visibleTurnItems.flatMap((row) =>
      row.item.type === "user_message" ? [row.item.messageId] : [],
    ),
  );
}

/**
 * Queued input is server-owned before it has a visible turn item. Treat its
 * projected conversation message as acknowledgement, while keeping ordinary
 * and steer input behind the visible-item guard above.
 */
export function deriveAcknowledgedOptimisticUserMessageIds(input: {
  readonly optimisticMessages: ReadonlyArray<Pick<ChatMessage, "id" | "inputIntent">>;
  readonly committedServerMessageIds: ReadonlySet<ChatMessage["id"]>;
  readonly projectedServerMessageIds: ReadonlySet<ChatMessage["id"]>;
}): ReadonlySet<ChatMessage["id"]> {
  return new Set(
    input.optimisticMessages.flatMap((message) =>
      input.committedServerMessageIds.has(message.id) ||
      (message.inputIntent === "queued_turn" && input.projectedServerMessageIds.has(message.id))
        ? [message.id]
        : [],
    ),
  );
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestRun: Thread["latestRun"] | null;
  latestUserMessageId?: ChatMessage["id"] | null;
  runtime: Thread["runtime"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (input.hasPendingApproval || input.hasPendingUserInput || Boolean(input.threadError)) {
    return true;
  }

  const latestRun = input.latestRun ?? null;
  const runtime = input.runtime ?? null;
  const latestUserMessageChanged =
    input.localDispatch.latestUserMessageId !== (input.latestUserMessageId ?? null);
  const latestRunChanged =
    input.localDispatch.latestRunId !== (latestRun?.runId ?? null) ||
    input.localDispatch.latestRunRequestedAt !== (latestRun?.requestedAt ?? null) ||
    input.localDispatch.latestRunStartedAt !== (latestRun?.startedAt ?? null) ||
    input.localDispatch.latestRunCompletedAt !== (latestRun?.completedAt ?? null);

  if (input.phase === "running") {
    if (latestUserMessageChanged) {
      return true;
    }
    if (!latestRunChanged) {
      return false;
    }
    if (latestRun?.startedAt === null || latestRun === null) {
      return false;
    }
    if (
      runtime?.activeRunId !== null &&
      runtime?.activeRunId !== undefined &&
      latestRun?.runId !== runtime.activeRunId
    ) {
      return false;
    }
    return true;
  }

  return (
    latestRunChanged ||
    input.localDispatch.runtimeStatus !== (runtime?.status ?? null) ||
    input.localDispatch.runtimeUpdatedAt !== (runtime?.updatedAt ?? null)
  );
}
