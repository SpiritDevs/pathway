import { useEffect, useState } from "react";
import { ProviderInstanceId } from "@spiritdevs/contracts";
import type { ThreadQueueDestination } from "@spiritdevs/contracts/threadQueue";
import { useAtomValue } from "@effect/atom-react";
import { threadQueueAccountAtom, threadQueueDestinationsAtom } from "../../cloud/threadQueueState";
import {
  flushThreadQueue,
  mutateQueuedThread,
  subscribeQueueDestinations,
  threadQueueErrorMessage,
} from "../../cloud/threadQueue";
import type { useThreadQueueChat } from "../../cloud/useThreadQueueChat";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";

/** Delivery is a status of the normal conversation, never a separate messaging surface. */
export function ThreadQueueStatus({ queue }: { queue: ReturnType<typeof useThreadQueueChat> }) {
  const { row } = queue;
  const registered = useAtomValue(threadQueueDestinationsAtom);
  const account = useAtomValue(threadQueueAccountAtom);
  const [moving, setMoving] = useState(false);
  const [destinations, setDestinations] = useState<readonly ThreadQueueDestination[]>([]);
  const [targetKey, setTargetKey] = useState("");
  const [modelKey, setModelKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!moving || !row?.cloudSaved) return;
    return subscribeQueueDestinations(row.threadId, setDestinations);
  }, [moving, row?.cloudSaved, row?.threadId, account]);
  if (!row) return null;
  const destination = registered.find(
    (destination) => destination.environmentId === row.environmentId,
  );
  const waiting = row.waitingToSync;
  const active = waiting || row.state !== "delivered";
  if (!active && !queue.error && !error) return null;
  const label = waiting
    ? "Saved on this device · Waiting to sync"
    : row.state === "canceled"
      ? row.cloudSaved
        ? "Saved to cloud · Canceled"
        : "Saved on this device · Canceled"
      : row.state === "blocked"
        ? "Saved to cloud · Needs attention"
        : row.state === "accepted"
          ? "Saved to cloud · Starting"
          : "Saved to cloud · Queued";
  const targets = destinations.flatMap<{
    key: string;
    destination: ThreadQueueDestination;
    project: ThreadQueueDestination["projects"][number] | null;
  }>((destination) =>
    destination.environmentId === row.environmentId
      ? []
      : row.localProjectId === null
        ? [{ key: destination.environmentId, destination, project: null }]
        : destination.projects.map((project) => ({
            key: `${destination.environmentId}:${project.localProjectId}`,
            destination,
            project,
          })),
  );
  const target = targets.find((target) => target.key === targetKey);
  const models =
    target?.destination.providers
      .filter((provider) => provider.enabled && provider.available)
      .flatMap((provider) =>
        provider.modelIds.map((model) => ({
          key: `${provider.instanceId}:${model}`,
          provider,
          model,
        })),
      ) ?? [];
  const model = models.find((model) => model.key === modelKey);
  return (
    <>
      <div
        className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-center gap-x-2 px-3 pb-2 text-xs text-muted-foreground"
        role="status"
      >
        <span>{label}</span>
        {waiting ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              void flushThreadQueue();
            }}
          >
            Retry sync
          </Button>
        ) : null}
        {row.launch && row.acceptedAt === null && row.cloudSaved ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={waiting}
            title={waiting ? "Sync pending messages before moving this thread." : undefined}
            onClick={() => setMoving(true)}
          >
            Move to another environment
          </Button>
        ) : null}
        {destination && !destination.durableThreadQueue ? (
          <span>Update Pathway on this environment to run saved messages.</span>
        ) : null}
        {queue.error || row.error || error ? (
          <span role="alert" className="w-full text-center text-destructive">
            {queue.error || error || row.error}
          </span>
        ) : null}
      </div>
      <Dialog open={moving} onOpenChange={setMoving}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Move queued thread</DialogTitle>
            <DialogDescription>
              Choose an environment and model. This conversation will start there when it connects.
              Project threads start in the selected project’s root directory.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 px-6 pb-4">
            <label className="block text-sm">
              Environment and project
              <select
                aria-label="Destination project and environment"
                className="mt-1 w-full rounded-md border bg-background p-2"
                value={targetKey}
                onChange={(event) => {
                  setTargetKey(event.target.value);
                  setModelKey("");
                }}
              >
                <option value="">Choose destination</option>
                {targets.map((target) => (
                  <option key={target.key} value={target.key}>
                    {target.destination.label}
                    {target.project ? ` · ${target.project.title}` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">
              Model
              <select
                aria-label="Destination model"
                className="mt-1 w-full rounded-md border bg-background p-2"
                value={modelKey}
                onChange={(event) => setModelKey(event.target.value)}
              >
                <option value="">Choose model</option>
                {models.map((model) => (
                  <option key={model.key} value={model.key}>
                    {model.provider.displayName} · {model.model}
                  </option>
                ))}
              </select>
            </label>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMoving(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy || waiting || !target || !model}
              onClick={() => {
                if (!target || !model) return;
                setBusy(true);
                setError(null);
                void mutateQueuedThread("reassign", {
                  threadId: row.threadId,
                  revision: row.revision,
                  environmentId: target.destination.environmentId,
                  localProjectId: target.project?.localProjectId ?? null,
                  modelSelection: {
                    instanceId: ProviderInstanceId.make(model.provider.instanceId),
                    model: model.model,
                  },
                  workspaceStrategy: { type: "root" },
                })
                  .then(() => setMoving(false))
                  .catch((cause) => setError(threadQueueErrorMessage(cause)))
                  .finally(() => setBusy(false));
              }}
            >
              {busy ? "Moving…" : "Move thread"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </>
  );
}
