import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  ThreadId,
  type ServerProvider,
} from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import type {
  ThreadQueueDestination,
  ThreadQueueSubmission,
  ThreadQueueThread,
} from "@spiritdevs/contracts/threadQueue";
import type { ThreadQueueOutboxRecord } from "@spiritdevs/client-runtime/sync/thread-queue-outbox";
import { buildLocalDraftThread } from "../components/ChatView.logic";
import {
  DEFAULT_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type ChatMessage,
  type Project,
} from "../types";
import { NO_PROVIDER_MODEL_SELECTION } from "../providerInstances";

export interface QueuedChatMessage {
  commandId: string;
  messageId: string;
  revision: number;
  state: ThreadQueueThread["state"];
  submission: ThreadQueueSubmission;
  localKey: string | null;
  submissionStarted: boolean;
  acceptedAt: number | null;
  rejection?: "command" | "initial-message" | null;
  createdAt: number;
  error: string | null;
}

export function queueMessageContent(message: QueuedChatMessage) {
  return message.submission.kind === "launch"
    ? message.submission.input.initialMessage
    : message.submission.input;
}

export function queuedChatMessageLabel(message: QueuedChatMessage) {
  if (message.state === "canceled") return "Canceled";
  if (message.localKey) return "Waiting to sync";
  if (message.state === "accepted") return "Starting";
  if (message.state === "blocked") return "Needs attention";
  if (message.state === "delivered") return "Sent";
  return "Queued";
}

export function canEditQueuedChatMessage(message: QueuedChatMessage) {
  return (
    message.acceptedAt === null &&
    !message.submissionStarted &&
    (message.state === "queued" || message.state === "blocked" || message.state === "canceled")
  );
}

export function canCancelQueuedChatMessage(message: QueuedChatMessage) {
  return (
    !message.submissionStarted &&
    message.state !== "canceled" &&
    (canEditQueuedChatMessage(message) ||
      (message.state === "blocked" && message.rejection != null))
  );
}

export function canRetryQueuedChatMessage(message: QueuedChatMessage) {
  return (
    !message.submissionStarted && (message.state === "blocked" || message.state === "canceled")
  );
}

export function queuedChatMessages(
  messages: readonly QueuedChatMessage[],
  attachmentUrls: ReadonlyMap<string, string>,
): ChatMessage[] {
  return messages.flatMap((message) => {
    const content = queueMessageContent(message);
    if (!content) return [];
    const timestamp = new Date(message.createdAt).toISOString();
    return [
      {
        id: MessageId.make(message.messageId),
        role: "user" as const,
        text: content.text,
        attachments: content.attachments.map((attachment) => ({
          ...attachment,
          ...(attachmentUrls.has(attachment.id)
            ? { previewUrl: attachmentUrls.get(attachment.id)! }
            : {}),
        })),
        runId: null,
        streaming: false,
        createdBy: "user" as const,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ];
  });
}

/** Queue sequence wins over component-local insertion order and cloud upload timestamps. */
export function mergeQueuedChatTimelineMessages(
  optimistic: readonly ChatMessage[],
  queued: readonly ChatMessage[],
  visibleMessageIds: ReadonlySet<string>,
) {
  const queueIds = new Set(queued.map((message) => message.id));
  return [...queued, ...optimistic.filter((message) => !queueIds.has(message.id))].filter(
    (message) => !visibleMessageIds.has(message.id),
  );
}

export function queuedLocalChatMessage(
  row: ThreadQueueOutboxRecord<ThreadQueueSubmission>,
): QueuedChatMessage {
  const content =
    row.submission.kind === "launch" ? row.submission.input.initialMessage : row.submission.input;
  return {
    commandId: row.commandId,
    messageId: content?.messageId ?? row.commandId,
    revision: row.revision ?? 1,
    state: row.canceled ? "canceled" : "queued",
    submission: row.submission,
    localKey: row.key,
    submissionStarted: row.submissionStarted ?? false,
    acceptedAt: null,
    createdAt: row.createdAt,
    error: row.error ?? null,
  };
}

/** Registered capabilities populate the normal picker when an environment has no local snapshot. */
export function queueDestinationProviders(
  destination: ThreadQueueDestination | undefined,
): readonly ServerProvider[] {
  return (
    destination?.providers.map((provider) => ({
      instanceId: ProviderInstanceId.make(provider.instanceId),
      driver: ProviderDriverKind.make(provider.driver),
      displayName: provider.displayName,
      enabled: provider.enabled,
      installed: provider.available,
      availability: provider.available ? ("available" as const) : ("unavailable" as const),
      version: null,
      status: provider.enabled ? ("ready" as const) : ("disabled" as const),
      auth: { status: "unknown" as const },
      checkedAt: new Date(0).toISOString(),
      models: provider.modelIds.map((model) => ({
        slug: model,
        name: model,
        isCustom: false,
        capabilities: null,
      })),
      slashCommands: [],
      skills: [],
    })) ?? []
  );
}

export function queuedThreadShell(
  row: ThreadQueueThread | undefined,
  companyId: CompanyId | null,
  messages: readonly QueuedChatMessage[] = [],
  providers: readonly ServerProvider[] = [],
) {
  if (!row) return undefined;
  const launch = row.launch;
  const latestSubmission = messages.at(-1)?.submission;
  const fallbackProvider = providers.find(
    (provider) => provider.enabled && provider.models.length > 0,
  );
  const modelSelection =
    launch?.modelSelection ??
    latestSubmission?.input.modelSelection ??
    (fallbackProvider?.models[0]
      ? { instanceId: fallbackProvider.instanceId, model: fallbackProvider.models[0].slug }
      : NO_PROVIDER_MODEL_SELECTION);
  const workspace = launch?.workspaceStrategy ?? { type: "root" as const };
  const threadId = ThreadId.make(row.threadId);
  const shell = buildLocalDraftThread(
    threadId,
    {
      threadId,
      environmentId: EnvironmentId.make(row.environmentId),
      projectId: row.localProjectId ? ProjectId.make(row.localProjectId) : null,
      conversationCompanyId: launch?.conversationCompanyId ?? companyId,
      temporary: launch?.temporary ?? false,
      logicalProjectKey: "",
      createdAt: new Date(row.createdAt).toISOString(),
      runtimeMode:
        launch?.runtimeMode ??
        (latestSubmission?.kind === "message" ? latestSubmission.runtimeMode : undefined) ??
        DEFAULT_RUNTIME_MODE,
      interactionMode:
        launch?.interactionMode ??
        (latestSubmission?.kind === "message" ? latestSubmission.interactionMode : undefined) ??
        DEFAULT_INTERACTION_MODE,
      locations: launch?.locations ?? ["agents"],
      branch:
        workspace.type === "worktree"
          ? (workspace.branch ?? workspace.baseRef)
          : (workspace.branch ?? null),
      worktreePath: workspace.type === "existing_worktree" ? workspace.worktreePath : null,
      envMode: workspace.type === "worktree" ? "worktree" : "local",
      startFromOrigin: false,
    },
    modelSelection,
  );
  return { ...shell, title: row.title };
}

export function queueDestinationProject(
  destination: ThreadQueueDestination | undefined,
  projectId: string | null | undefined,
): Project | null {
  const project = destination?.projects.find((project) => project.localProjectId === projectId);
  if (!project || !destination) return null;
  return {
    id: ProjectId.make(project.localProjectId),
    environmentId: EnvironmentId.make(destination.environmentId),
    title: project.title,
    workspaceRoot: project.workspaceRoot,
    defaultModelSelection: null,
    scripts: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}
