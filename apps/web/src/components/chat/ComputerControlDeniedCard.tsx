// Transcript card shown when an agent's desktop tool call was rejected because
// the chat has computer control switched off. Replaces the buried tool error
// with a one-click way to switch control on and retry, or, when this device's
// pairing is what keeps it out, says so instead of offering a toggle that
// cannot help.

import type { EnvironmentId } from "@spiritdevs/contracts";

import { useCanUseComputer } from "~/hooks/useComputerAccess";
import { ComputerActionCard } from "./ComputerActionCard";
import { COMPUTER_ACCESS_DENIED_HINT } from "./ComputerControlDeniedCard.logic";

export function ComputerControlDeniedCard({
  computerControlEnabled,
  accessDenied = false,
  onEnable,
}: {
  // Live composer state: once the user (or this card) switches control on, the
  // card flips to a confirmation instead of offering a dead button.
  readonly computerControlEnabled?: boolean | undefined;
  /** This device's pairing lacks Computer access, so the toggle cannot help. */
  readonly accessDenied?: boolean;
  readonly onEnable?: (() => void) | undefined;
}) {
  if (accessDenied) {
    return (
      <ComputerActionCard tone="error" title="This device can't use Computer">
        <p>{COMPUTER_ACCESS_DENIED_HINT}</p>
      </ComputerActionCard>
    );
  }
  const enabled = computerControlEnabled === true;
  return (
    <ComputerActionCard
      tone={enabled ? "success" : "warning"}
      title={enabled ? "Computer control is on for this chat" : "Computer control is off"}
      action={onEnable && !enabled ? { label: "Enable", onClick: onEnable } : undefined}
    >
      <p>
        {enabled
          ? "Queued desktop turns stay cancelled — send a fresh message to continue."
          : "Turn it on in Settings to let the agent use the desktop."}
      </p>
    </ComputerActionCard>
  );
}

type ConnectedProps = Omit<Parameters<typeof ComputerControlDeniedCard>[0], "accessDenied"> & {
  readonly environmentId: EnvironmentId;
};

/** Reads whether this client may use Computer on the thread's environment. */
export function ConnectedComputerControlDeniedCard({ environmentId, ...props }: ConnectedProps) {
  const allowed = useCanUseComputer(environmentId);
  return <ComputerControlDeniedCard {...props} accessDenied={!allowed} />;
}
