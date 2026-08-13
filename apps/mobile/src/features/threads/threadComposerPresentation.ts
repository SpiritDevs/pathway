import type {
  OrchestrationV2BrowserTakeoverFailure,
  OrchestrationV2BrowserTakeoverStatus,
} from "@t3tools/contracts";

export type CollapsedComposerAction = "send" | "stop";

/** A typed draft remains sendable while a run is active; only an empty pill becomes Stop. */
export function resolveCollapsedComposerAction(input: {
  readonly canStopThread: boolean;
  readonly hasContent: boolean;
}): CollapsedComposerAction {
  return input.canStopThread && !input.hasContent ? "stop" : "send";
}

export type BrowserTakeoverPillState = {
  /** `working` spins; `attention` shows the static dot. */
  readonly kind: "working" | "attention";
  readonly label: string;
};

const BROWSER_TAKEOVER_FAILURE_LABELS: Record<OrchestrationV2BrowserTakeoverFailure, string> = {
  already_finished: "The agent finished before the browser takeover.",
  continuation_failed: "Couldn't resume the agent after the browser takeover.",
  fence_failed: "Couldn't take the browser from the agent.",
  host_disconnected: "The desktop hosting the browser disconnected.",
  interrupt_failed: "Couldn't pause the agent for the browser takeover.",
  no_live_host: "No desktop is hosting this browser.",
  server_restarted: "The browser takeover ended with a server restart.",
};

/**
 * Mobile shows browser takeover as status only: the takeover is driven from the
 * Pathway desktop that hosts the agent's browser, so there is nothing here to
 * press. Returns null whenever no takeover owns the thread.
 */
export function resolveBrowserTakeoverPill(input: {
  readonly status: OrchestrationV2BrowserTakeoverStatus | null;
  readonly failure: OrchestrationV2BrowserTakeoverFailure | null;
}): BrowserTakeoverPillState | null {
  switch (input.status) {
    case "requested":
    case "pausing":
      return { kind: "working", label: "Pausing agent for browser takeover..." };
    case "active":
      return {
        kind: "attention",
        label: "Agent paused — browser takeover in progress on your desktop.",
      };
    case "proceeding":
      return { kind: "working", label: "Resuming agent..." };
    case "failed":
      return {
        kind: "attention",
        label:
          input.failure === null
            ? "The browser takeover failed."
            : BROWSER_TAKEOVER_FAILURE_LABELS[input.failure],
      };
    case "completed":
    case "cancelled":
    case null:
      return null;
  }
}
