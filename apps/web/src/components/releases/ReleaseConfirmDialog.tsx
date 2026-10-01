import type { EnvironmentId } from "@spiritdevs/contracts";
import type {
  LocalReleaseArchive,
  ReleaseJob,
  ReleaseOrganizer,
} from "@spiritdevs/contracts/releases";
import { squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";
import { useState } from "react";

import { useAppleAccountsClient, useAppleCloudQuery } from "~/cloud/appleAccounts";
import { appleReleaseFunctions } from "~/cloud/appleReleases";
import { useEnvironment } from "~/state/environments";
import { releaseEnvironment } from "~/state/releases";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { describeReleaseAction, describeReleaseFailure } from "./Releases.logic";
import { ReleasePublishingToggle, useReleasePublishing } from "./ReleasePublishingToggle";

export interface ReleaseConfirmContext {
  readonly appName: string;
  readonly organizer: ReleaseOrganizer | null;
  readonly archives: ReadonlyArray<LocalReleaseArchive>;
}

/**
 * The only path to `releases.execute`. Everything shown comes from the Cloud intent, which is
 * immutable once prepared, so the user confirms exactly what the environment will send.
 */
export function ReleaseConfirmation({
  intentId,
  context,
  onDone,
}: {
  intentId: string;
  context: ReleaseConfirmContext;
  onDone: (job: ReleaseJob | null) => void;
}) {
  const client = useAppleAccountsClient();
  const intent = useAppleCloudQuery(client, appleReleaseFunctions.intent, { intentId });
  const data = intent.data ?? null;
  const publishing = useReleasePublishing(data?.target ?? null);
  const environment = useEnvironment((data?.environmentId ?? null) as EnvironmentId | null);
  const execute = useAtomCommand(releaseEnvironment.execute, { reportFailure: false });
  const [pending, setPending] = useState<"confirm" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (intent.error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {describeReleaseFailure(intent.error, "This confirmation is unavailable.")}
      </p>
    );
  }
  if (data === null) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const summary = describeReleaseAction(data.action, context);
  const environmentLabel = environment?.label ?? "an environment that is not connected";
  const connected = environment?.connection.phase === "connected";
  const expired = data.expiresAt <= Date.now();
  const open = data.state === "pending" || data.state === "approved";
  const enabled = publishing.data?.enabled === true;

  const confirm = async () => {
    if (!client || pending) return;
    setPending("confirm");
    setError(null);
    try {
      // An approval that already landed (for example after a dropped connection) is not re-confirmed.
      if (data.state === "pending") {
        await client.mutation(appleReleaseFunctions.confirm, { intentId });
      }
      const result = await execute({
        environmentId: data.environmentId as EnvironmentId,
        input: { ...data.target, intentId },
      });
      if (result._tag === "Failure") {
        setError(
          describeReleaseFailure(squashAtomCommandFailure(result), "The release did not start."),
        );
        return;
      }
      onDone(result.value);
    } catch (cause) {
      setError(describeReleaseFailure(cause, "The release was not confirmed."));
    } finally {
      setPending(null);
    }
  };
  const discard = async () => {
    if (!client || pending) return;
    setPending("discard");
    setError(null);
    try {
      if (open) await client.mutation(appleReleaseFunctions.cancel, { intentId });
      onDone(null);
    } catch (cause) {
      setError(describeReleaseFailure(cause, "The confirmation was not discarded."));
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <p className="text-sm font-medium">{summary.title}</p>
        <p className="text-xs text-muted-foreground">{summary.consequence}</p>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">App</dt>
        <dd>
          {context.appName} <span className="font-mono text-xs">({data.target.appId})</span>
        </dd>
        <dt className="text-muted-foreground">Team</dt>
        <dd className="font-mono text-xs leading-5">{data.target.teamId}</dd>
        <dt className="text-muted-foreground">Runs on</dt>
        <dd>{environmentLabel}</dd>
        {summary.rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-muted-foreground">{row.label}</dt>
            <dd className="break-all whitespace-pre-wrap">{row.value}</dd>
          </div>
        ))}
      </dl>
      {!open ? (
        <p className="text-sm text-muted-foreground">
          {data.state === "consumed"
            ? "This confirmation was already used."
            : "This confirmation was discarded."}
        </p>
      ) : expired ? (
        <p className="text-sm text-muted-foreground">
          This confirmation expired. Prepare it again to continue.
        </p>
      ) : !enabled && publishing.data ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2">
          <p className="text-xs text-muted-foreground">
            Publishing is off for this app. Turn it on to confirm.
          </p>
          <ReleasePublishingToggle target={data.target} appName={context.appName} />
        </div>
      ) : !connected ? (
        <p className="text-sm text-muted-foreground">
          Connect to {environmentLabel} to send this. Apple receives it from that environment.
        </p>
      ) : (
        <p className="text-xs text-muted-foreground">
          Expires at {new Date(data.expiresAt).toLocaleTimeString()}. Writes are never retried
          automatically. If something fails, check the Organizer before preparing again.
        </p>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" disabled={pending !== null} onClick={() => void discard()}>
          {open ? (pending === "discard" ? "Discarding…" : "Discard") : "Close"}
        </Button>
        {open ? (
          <Button
            disabled={pending !== null || expired || !enabled || !connected}
            onClick={() => void confirm()}
          >
            {pending === "confirm" ? "Sending…" : summary.confirmLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function ReleaseConfirmDialog({
  intentId,
  context,
  onClose,
}: {
  intentId: string | null;
  context: ReleaseConfirmContext;
  onClose: (job: ReleaseJob | null) => void;
}) {
  return (
    <Dialog
      open={intentId !== null}
      onOpenChange={(open) => {
        if (!open) onClose(null);
      }}
    >
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Confirm release</DialogTitle>
          <DialogDescription>
            Nothing is sent to Apple until you confirm. Agents can prepare releases but only you can
            send them.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {intentId !== null ? (
            <ReleaseConfirmation
              key={intentId}
              intentId={intentId}
              context={context}
              onDone={onClose}
            />
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
