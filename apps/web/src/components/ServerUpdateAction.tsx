import type { EnvironmentId, ServerSelfUpdateCapability } from "@spiritdevs/contracts";
import type { ServerUpdateStage, ServerUpdateState } from "@spiritdevs/client-runtime/state/server";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@spiritdevs/client-runtime/state/runtime";

import { requestConfirmDialog } from "~/confirmDialog";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { manualServerUpdateCommand } from "~/versionSkew";
import { Spinner } from "./ui/spinner";
import { Button } from "./ui/button";
import { toastManager } from "./ui/toast";

const UPDATE_STAGE_LABELS: Record<ServerUpdateStage, string> = {
  checking: "Checking for updates…",
  downloading: "Downloading update…",
  installing: "Installing update…",
  resuming: "Reconnecting…",
};
const pendingUpdateEnvironmentIds = new Set<EnvironmentId>();

export function serverUpdateStageLabel(stage: ServerUpdateStage): string {
  return UPDATE_STAGE_LABELS[stage];
}

function updateFailureMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Server update failed.";
}

/** The same update stages used in the composer bar and Connections settings. */
export function ServerUpdateProgress({
  state,
}: {
  readonly state: Exclude<ServerUpdateState, { status: "idle" }>;
}) {
  if (state.status === "failed") {
    return (
      <div className="mt-1 flex min-w-0 items-center gap-2 text-xs text-destructive" role="alert">
        <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-hidden="true" />
        <span className="min-w-0 truncate" title={state.message}>
          {state.message}
        </span>
      </div>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-2 text-xs font-medium text-foreground" role="status">
      <Spinner className="size-3.5 shrink-0 motion-reduce:animate-none" aria-hidden="true" />
      <span>{serverUpdateStageLabel(state.stage)}</span>
    </div>
  );
}

/**
 * Offers the update path advertised by a version-skewed server. Self-updates
 * delegate their full lifecycle to client-runtime so this component can
 * unmount during reconnect without losing operation state.
 */
export function ServerUpdateAction({
  environmentId,
  serverLabel,
  selfUpdate,
  desktopAppUpdate = false,
  targetVersion,
  label = "Update",
}: {
  readonly environmentId: EnvironmentId;
  readonly serverLabel: string;
  readonly selfUpdate: ServerSelfUpdateCapability | null;
  /** The desktop app supervising this server accepts remote update
      requests (capabilities.desktopAppUpdate). */
  readonly desktopAppUpdate?: boolean;
  readonly targetVersion: string;
  readonly label?: string;
}) {
  const isDesktopAppUpdate = selfUpdate === "desktop-managed";
  const updateServer = useAtomCommand(serverEnvironment.updateServer, {
    reportFailure: false,
  });
  const { copyToClipboard } = useCopyToClipboard<{ command: string }>({
    target: "update command",
    onCopy: ({ command }) => {
      toastManager.add({
        type: "success",
        title: "Update command copied",
        description: `Run \`${command}\` on ${serverLabel} to update it.`,
      });
    },
    onError: (error) => {
      toastManager.add({
        type: "error",
        title: "Could not copy update command",
        description: error.message,
      });
    },
  });

  const handleUpdate = async () => {
    if (pendingUpdateEnvironmentIds.has(environmentId)) {
      return;
    }
    pendingUpdateEnvironmentIds.add(environmentId);
    try {
      if (isDesktopAppUpdate) {
        // Without a dialog host the click remains the explicit update request.
        const confirmed =
          (await requestConfirmDialog(
            `Update the Pathway desktop app that runs ${serverLabel}? It will close and relaunch on that machine.`,
          )) ?? true;
        if (!confirmed) return;
      }
      const result = await updateServer({
        environmentId,
        input: { targetVersion },
      });
      if (result._tag === "Failure") {
        if (isAtomCommandInterrupted(result)) {
          return;
        }
        toastManager.add({
          type: "error",
          title: "Server update failed",
          description: updateFailureMessage(squashAtomCommandFailure(result)),
        });
        return;
      }
      toastManager.add({
        type: "success",
        title: `${serverLabel} updated`,
        description: isDesktopAppUpdate
          ? `Desktop app relaunched on ${result.value.targetVersion}.`
          : `Reconnected on @spiritdevs/pathway@${result.value.targetVersion}.`,
      });
    } finally {
      pendingUpdateEnvironmentIds.delete(environmentId);
    }
  };

  if (selfUpdate === "desktop-managed" && !desktopAppUpdate) {
    return (
      <span className="text-muted-foreground text-xs">
        Update the desktop app on that machine to update this server.
      </span>
    );
  }

  if (selfUpdate === null) {
    const command = manualServerUpdateCommand(targetVersion);
    return (
      <Button size="xs" variant="outline" onClick={() => copyToClipboard(command, { command })}>
        Copy update command
      </Button>
    );
  }

  return (
    <Button size="xs" onClick={() => void handleUpdate()}>
      {label}
    </Button>
  );
}
