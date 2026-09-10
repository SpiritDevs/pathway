import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";
import {
  EnvironmentId,
  ChatAttachmentId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type ProjectId,
} from "@spiritdevs/contracts";
import type { ThreadQueueDetail } from "@spiritdevs/contracts/threadQueue";
import {
  threadQueueEntriesAtom,
  localThreadQueueAtom,
  threadQueueAccountAtom,
} from "../cloud/threadQueueState";
import {
  flushThreadQueue,
  mutateQueuedThread,
  mutateLocalQueuedMessage,
  queueThreadTurn,
  subscribeQueuedThread,
  subscribeQueueDestinations,
  threadQueueErrorMessage,
  type ThreadQueueDestination,
} from "../cloud/threadQueue";
import { useThreadShell } from "../state/entities";
import { newMessageId } from "../lib/utils";
import { Button } from "./ui/button";

export function QueuedThreadPanel({
  threadId,
  compact = false,
  allowCompose = false,
}: {
  threadId: string;
  compact?: boolean;
  allowCompose?: boolean;
}) {
  const entries = useAtomValue(threadQueueEntriesAtom);
  const local = useAtomValue(localThreadQueueAtom);
  const row = entries.find((entry) => entry.threadId === threadId);
  const [detail, setDetail] = useState<ThreadQueueDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [moving, setMoving] = useState(false);
  const [projectKey, setProjectKey] = useState("");
  const [modelKey, setModelKey] = useState("");
  const account = useAtomValue(threadQueueAccountAtom);
  const [destinations, setDestinations] = useState<readonly ThreadQueueDestination[]>([]);
  useEffect(
    () =>
      row
        ? subscribeQueueDestinations(row.cloudSaved ? threadId : undefined, setDestinations)
        : undefined,
    [threadId, account, row?.cloudSaved, Boolean(row)],
  );
  const existingThread = useThreadShell(
    row
      ? { environmentId: EnvironmentId.make(row.environmentId), threadId: ThreadId.make(threadId) }
      : null,
  );
  useEffect(() => {
    setDetail(null);
    if (!row?.cloudSaved) return;
    return subscribeQueuedThread(threadId, setDetail);
  }, [threadId, row?.cloudSaved, Boolean(row), account]);
  if (!row) return null;
  const cloudMessages = detail?.thread.threadId === threadId ? detail.messages : [];
  const cloudIds = new Set(cloudMessages.map((message) => message.commandId));
  const messages = [
    ...cloudMessages.map((message) => ({
      ...message,
      localKey: null as string | null,
      submissionStarted: false,
    })),
    ...local
      .filter((item) => item.threadId === threadId && !cloudIds.has(item.commandId))
      .map((item, index) => ({
        commandId: item.commandId,
        revision: item.revision ?? 1,
        state: item.canceled ? ("canceled" as const) : ("queued" as const),
        sequence: cloudMessages.length + index,
        submission: item.submission,
        localKey: item.key,
        submissionStarted: item.submissionStarted ?? false,
      })),
  ];
  const visibleMessages = messages.filter((message) => message.state !== "delivered");
  if (compact && !allowCompose && visibleMessages.length === 0 && row.state === "delivered")
    return null;
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(threadQueueErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const launch = row.launch;
  const projects = destinations.flatMap((destination) =>
    destination.projects.map((project) => ({
      ...project,
      environmentId: destination.environmentId,
      environmentLabel: destination.label,
      id: project.localProjectId,
    })),
  );
  const targetProject = projects.find(
    (project) => `${project.environmentId}:${project.id}` === projectKey,
  );
  const destinationEnvironmentId =
    targetProject?.environmentId ?? (row.localProjectId === null && projectKey ? projectKey : null);
  const providers =
    destinations.find((destination) => destination.environmentId === destinationEnvironmentId)
      ?.providers ?? [];
  const models = providers
    .filter((provider) => provider.enabled && provider.available)
    .flatMap((provider) =>
      provider.modelIds.map((model) => ({
        key: `${provider.instanceId}:${model}`,
        label: `${provider.displayName}: ${model}`,
        selection: {
          instanceId: ProviderInstanceId.make(provider.instanceId),
          model,
        } as ModelSelection,
      })),
    );
  const targetModel = models.find((model) => model.key === modelKey);
  const send = () =>
    run(async () => {
      const selection = launch?.modelSelection ?? existingThread?.modelSelection;
      if (!selection)
        throw new Error("Open the conversation composer to choose a model before sending.");
      await queueThreadTurn({
        environmentId: EnvironmentId.make(row.environmentId),
        durableAttachments: files.map((file, index) => ({
          metadata: {
            id: ChatAttachmentId.make(`queued-file-${index}`),
            type: file.type.startsWith("image/") ? "image" : "file",
            name: file.name,
            mimeType: file.type || "application/octet-stream",
            sizeBytes: file.size,
          },
          blob: file,
        })),
        input: {
          threadId: ThreadId.make(threadId),
          message: {
            messageId: newMessageId(),
            role: "user",
            text: text || "Please review the attached files.",
            attachments: [],
          },
          modelSelection: selection,
          runtimeMode: launch?.runtimeMode ?? existingThread!.runtimeMode,
          interactionMode: launch?.interactionMode ?? existingThread!.interactionMode,
        },
      });
      setText("");
      setFiles([]);
    });
  return (
    <section
      aria-label="Queued messages"
      className={
        compact
          ? "mx-4 my-3 rounded-xl border p-4"
          : "mx-auto flex w-full max-w-3xl flex-col gap-5 overflow-y-auto px-6 py-10"
      }
    >
      {!compact ? <h1 className="text-xl font-semibold">{row.title}</h1> : null}
      <div role="status" className="text-sm text-muted-foreground">
        {!row.cloudSaved && row.state === "canceled"
          ? "Canceled · Saved on this device"
          : row.waitingToSync
            ? "Waiting to sync · Saved on this device"
            : row.state === "accepted"
              ? "Saved to cloud · Accepted by environment"
              : row.state === "blocked"
                ? "Saved to cloud · Needs attention"
                : row.state === "canceled"
                  ? "Saved to cloud · Canceled"
                  : "Saved to cloud · Queued for environment"}
        <p className="mt-1">
          Queued messages run in order when the environment is available. You can leave this thread
          safely.
        </p>
      </div>
      {destinations.some(
        (destination) =>
          destination.environmentId === row.environmentId && !destination.durableThreadQueue,
      ) ? (
        <p className="text-sm text-muted-foreground">
          Update Pathway on this environment to run queued messages. Your saved messages will be
          delivered automatically after the update.
        </p>
      ) : null}
      {row.error ? <p className="text-sm text-destructive">{row.error}</p> : null}
      {visibleMessages.map((message) => {
        const content =
          message.submission.kind === "launch"
            ? message.submission.input.initialMessage
            : message.submission.input;
        if (!content) return null;
        const editable =
          !message.submissionStarted &&
          (message.state === "queued" ||
            message.state === "blocked" ||
            message.state === "canceled");
        return (
          <article key={message.commandId} className="space-y-3 rounded-lg bg-muted/50 p-4">
            {editing === message.commandId ? (
              <textarea
                aria-label="Edit queued message"
                value={editText}
                onChange={(event) => setEditText(event.target.value)}
                className="min-h-24 w-full rounded border bg-background p-2"
              />
            ) : (
              <p className="whitespace-pre-wrap break-words text-sm">{content.text}</p>
            )}
            {content.attachments.map((attachment) => (
              <p key={attachment.id} className="text-xs text-muted-foreground">
                {attachment.name}
              </p>
            ))}
            {message.submissionStarted ? (
              <p className="text-xs text-muted-foreground">
                Waiting for cloud confirmation before this message can be changed.
              </p>
            ) : null}
            {editable ? (
              <div className="flex gap-2">
                {editing === message.commandId ? (
                  <Button
                    size="sm"
                    disabled={busy || !editText.trim()}
                    onClick={() => {
                      void run(async () => {
                        if (message.localKey)
                          await mutateLocalQueuedMessage(
                            message.localKey,
                            message.revision,
                            "edit",
                            editText,
                          );
                        else
                          await mutateQueuedThread("edit", {
                            threadId,
                            commandId: message.commandId,
                            revision: message.revision,
                            text: editText,
                          });
                        setEditing(null);
                      });
                    }}
                  >
                    Save edit
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => {
                      setEditing(message.commandId);
                      setEditText(content.text);
                    }}
                  >
                    Edit
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => {
                    void run(() =>
                      message.localKey
                        ? mutateLocalQueuedMessage(
                            message.localKey,
                            message.revision,
                            message.state === "canceled" ? "retry" : "cancel",
                          )
                        : mutateQueuedThread(
                            message.state === "canceled" || message.state === "blocked"
                              ? "retry"
                              : "cancel",
                            { threadId, commandId: message.commandId, revision: message.revision },
                          ),
                    );
                  }}
                >
                  {message.state === "canceled" || message.state === "blocked" ? "Retry" : "Cancel"}
                </Button>
              </div>
            ) : null}
          </article>
        );
      })}
      {row.waitingToSync ? (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            void run(flushThreadQueue);
          }}
        >
          Retry cloud sync
        </Button>
      ) : null}
      {launch && row.acceptedAt === null && row.cloudSaved ? (
        <Button
          variant="outline"
          disabled={busy || row.waitingToSync}
          title={row.waitingToSync ? "Sync pending messages before moving this thread." : undefined}
          onClick={() => setMoving(!moving)}
        >
          Move to another environment
        </Button>
      ) : null}
      {moving ? (
        <div className="space-y-3 rounded-lg border p-4">
          <p className="text-sm">
            Choose the destination and a model available there. The original environment will no
            longer receive this queued thread. It will start in the selected project’s root
            directory.
          </p>
          <select
            aria-label="Destination project and environment"
            className="w-full rounded border bg-background p-2"
            value={projectKey}
            onChange={(event) => {
              setProjectKey(event.target.value);
              setModelKey("");
            }}
          >
            <option value="">Choose destination</option>
            {row.localProjectId === null
              ? destinations
                  .filter((destination) => destination.environmentId !== row.environmentId)
                  .map((destination) => (
                    <option key={destination.environmentId} value={destination.environmentId}>
                      {destination.label}
                    </option>
                  ))
              : projects
                  .filter((project) => project.environmentId !== row.environmentId)
                  .map((project) => (
                    <option
                      key={`${project.environmentId}:${project.id}`}
                      value={`${project.environmentId}:${project.id}`}
                    >
                      {project.title} · {project.environmentLabel}
                    </option>
                  ))}
          </select>
          <select
            aria-label="Destination model"
            className="w-full rounded border bg-background p-2"
            value={modelKey}
            onChange={(event) => setModelKey(event.target.value)}
          >
            <option value="">Choose model</option>
            {models.map((model) => (
              <option key={model.key} value={model.key}>
                {model.label}
              </option>
            ))}
          </select>
          <Button
            disabled={busy || row.waitingToSync || !destinationEnvironmentId || !targetModel}
            onClick={() => {
              if (!destinationEnvironmentId || !targetModel) return;
              void run(async () => {
                await mutateQueuedThread("reassign", {
                  threadId,
                  revision: row.revision,
                  environmentId: destinationEnvironmentId,
                  localProjectId: (targetProject?.id as ProjectId) ?? null,
                  modelSelection: targetModel.selection,
                  workspaceStrategy: { type: "root" },
                });
                setMoving(false);
              });
            }}
          >
            Move queued thread
          </Button>
        </div>
      ) : null}
      {(!compact || allowCompose) && (launch || existingThread) ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
          className="mt-auto space-y-2"
        >
          <textarea
            aria-label="Queue another message"
            placeholder="Add a message to the queue…"
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="min-h-24 w-full rounded-lg border bg-background p-3"
          />
          <label className="block text-sm">
            Attach files
            <input
              type="file"
              multiple
              className="mt-1 block w-full"
              onChange={(event) => {
                const incoming = [...(event.target.files ?? [])];
                setFiles((current) => [
                  ...new Map(
                    [...current, ...incoming].map((file) => [
                      `${file.name}:${file.size}:${file.lastModified}`,
                      file,
                    ]),
                  ).values(),
                ]);
                event.target.value = "";
              }}
            />
          </label>
          {files.map((file, index) => (
            <div
              key={`${file.name}:${file.size}:${file.lastModified}`}
              className="flex items-center gap-2 text-sm"
            >
              <span className="truncate">{file.name}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setFiles((current) => current.filter((_, i) => i !== index))}
              >
                Remove
              </Button>
            </div>
          ))}
          <Button type="submit" disabled={busy || (!text.trim() && files.length === 0)}>
            Queue message
          </Button>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
