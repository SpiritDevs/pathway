import {
  ORCHESTRATION_V2_BROWSER_TAKEOVER_ELIGIBLE_RUN_STATUSES,
  type CommandId,
  type OrchestrationV2BrowserTakeover,
  type OrchestrationV2BrowserTakeoverFailure,
  type OrchestrationV2BrowserTakeoverStatus,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadPreviewActivity,
  type RunId,
} from "@spiritdevs/contracts";
import { CircleAlertIcon, HandIcon, InfoIcon, MousePointerClickIcon } from "lucide-react";
import type { PointerEventHandler, ReactNode } from "react";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * Composer banner for ISS-41 browser takeover.
 *
 * Everything here is a pure function of the projected thread: the server owns
 * the takeover state machine and clients never infer exclusivity locally. The
 * only local state is a session-scoped dismissal set and, while a request is
 * still in flight, a busy flag on the button that asked for it.
 */

const SETTLED_BROWSER_TAKEOVER_STATUSES: ReadonlySet<OrchestrationV2BrowserTakeoverStatus> =
  new Set(["completed", "cancelled"]);

// Deliberately narrower than ACTIVE_RUN_STATUSES: a run parked at "waiting" is
// draining after its agent turn ended, and the server refuses to pause it.
const TAKEOVER_ELIGIBLE_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set(
  ORCHESTRATION_V2_BROWSER_TAKEOVER_ELIGIBLE_RUN_STATUSES,
);

/**
 * A settled takeover is over for good: the fence is gone and the thread is free
 * to offer a fresh takeover. Every other status — including `failed`, which can
 * still be holding the browser lease — keeps owning the banner slot.
 */
export function isBrowserTakeoverSettled(
  status: OrchestrationV2BrowserTakeoverStatus | null | undefined,
): boolean {
  return status !== null && status !== undefined && SETTLED_BROWSER_TAKEOVER_STATUSES.has(status);
}

/** Dismissals are per run, so declining once never suppresses the next run. */
export function browserTakeoverCalloutDismissKey(
  threadKey: string | null,
  runId: RunId | null,
): string | null {
  return threadKey === null || runId === null ? null : `callout\u0000${threadKey}\u0000${runId}`;
}

/** Dismissals are per takeover, so a later failure is never pre-dismissed. */
export function browserTakeoverFailureDismissKey(
  threadKey: string | null,
  takeoverId: CommandId,
): string | null {
  return threadKey === null ? null : `failure\u0000${threadKey}\u0000${takeoverId}`;
}

// Session-scoped (module-level so it survives ChatView remounts, e.g. route
// changes between threads). Mirrors ThreadErrorBanner's dismissal trio.
const sessionDismissedBrowserTakeoverKeys = new Set<string>();

export function dismissBrowserTakeoverBannerForSession(key: string | null): void {
  if (key !== null) {
    sessionDismissedBrowserTakeoverKeys.add(key);
  }
}

export function isBrowserTakeoverBannerDismissedForSession(key: string | null): boolean {
  return key !== null && sessionDismissedBrowserTakeoverKeys.has(key);
}

export interface BrowserTakeoverCalloutInput {
  /** Coalesced host/tab marker from the projection. */
  readonly previewActivity: OrchestrationV2ThreadPreviewActivity | null | undefined;
  /** Status of the thread's current takeover, if any. */
  readonly takeoverStatus: OrchestrationV2BrowserTakeoverStatus | null | undefined;
  /** Id of the run the thread is executing right now, null when idle. */
  readonly activeRunId: RunId | null;
  /** Status of that run; only some statuses can still be paused. */
  readonly activeRunStatus: OrchestrationV2RunStatus | null;
  /** This client can host a Preview browser (desktop runtime). */
  readonly previewSupported: boolean;
  /** This client's automation host id for the thread's environment. */
  readonly automationHostClientId: string | null;
  readonly dismissed: boolean;
}

/**
 * Only the desktop that is actually driving the agent's browser is invited to
 * take over: everyone else could stop the agent but could not touch the page,
 * so offering them the button would be a lie.
 */
export function shouldShowBrowserTakeoverCallout(input: BrowserTakeoverCalloutInput): boolean {
  if (!input.previewSupported) return false;
  const activity = input.previewActivity ?? null;
  if (activity === null) return false;
  // Stale activity: the browser work belongs to a run that already finished.
  if (input.activeRunId === null || activity.runId !== input.activeRunId) return false;
  // The run is still "active" in the sidebar sense but past the point where the
  // server can pause it, so offering Take over would only earn a rejection.
  if (
    input.activeRunStatus === null ||
    !TAKEOVER_ELIGIBLE_RUN_STATUSES.has(input.activeRunStatus)
  ) {
    return false;
  }
  // A takeover that is not settled still owns the browser (a failed one can
  // still be holding the lease), so it owns the banner slot too.
  const status = input.takeoverStatus ?? null;
  if (status !== null && !isBrowserTakeoverSettled(status)) return false;
  if (input.automationHostClientId === null) return false;
  if (input.automationHostClientId !== activity.hostClientId) return false;
  return !input.dismissed;
}

export interface BrowserTakeoverRevealInput {
  readonly takeover: OrchestrationV2BrowserTakeover | null | undefined;
  readonly previewSupported: boolean;
  readonly automationHostClientId: string | null;
  readonly availableTabIds: ReadonlySet<string>;
}

/** The exact locally available tab this hosting desktop should reveal once control is exclusive. */
export function resolveBrowserTakeoverTabToReveal(
  input: BrowserTakeoverRevealInput,
): string | null {
  const takeover = input.takeover ?? null;
  if (!input.previewSupported || takeover?.status !== "active") return null;
  if (
    takeover.hostClientId === null ||
    takeover.hostClientId !== input.automationHostClientId ||
    takeover.tabId === null ||
    !input.availableTabIds.has(takeover.tabId)
  ) {
    return null;
  }
  return takeover.tabId;
}

export type BrowserTakeoverActionKind = "take-over" | "proceed" | "release";

export interface BrowserTakeoverBannerAction {
  readonly kind: BrowserTakeoverActionKind;
  readonly label: string;
  readonly emphasis: "primary" | "secondary";
  readonly busy: boolean;
}

export type BrowserTakeoverBannerTone =
  | "callout"
  | "pausing"
  | "active"
  | "proceeding"
  | "failed"
  | "finished";

export interface BrowserTakeoverBannerDescriptor {
  readonly id: string;
  readonly tone: BrowserTakeoverBannerTone;
  readonly variant: ComposerBannerStackItem["variant"];
  readonly title: string;
  readonly description: string;
  readonly actions: ReadonlyArray<BrowserTakeoverBannerAction>;
  /** Render the title inside a polite live region instead of shouting it. */
  readonly transient: boolean;
  /** Non-null when the banner may be dismissed for the session. */
  readonly dismissKey: string | null;
  readonly dismissLabel: string | null;
  /** The takeover the actions target; null for the pre-takeover callout. */
  readonly takeoverId: CommandId | null;
}

export interface BrowserTakeoverBannerInput {
  readonly threadKey: string | null;
  readonly takeover: OrchestrationV2BrowserTakeover | null | undefined;
  readonly previewActivity: OrchestrationV2ThreadPreviewActivity | null | undefined;
  readonly activeRunId: RunId | null;
  readonly activeRunStatus: OrchestrationV2RunStatus | null;
  readonly previewSupported: boolean;
  readonly automationHostClientId: string | null;
  /** A takeover request this client sent that the projection has not echoed. */
  readonly requestPending: boolean;
  /** Overridable for tests; defaults to the module's session dismissal set. */
  readonly isDismissed?: (key: string | null) => boolean;
}

interface FailureCopy {
  readonly title: string;
  readonly description: string;
}

const FAILURE_COPY: Record<OrchestrationV2BrowserTakeoverFailure, FailureCopy> = {
  already_finished: {
    title: "The agent already finished",
    description: "The run ended before the browser could be handed over, so nothing was paused.",
  },
  continuation_failed: {
    title: "Couldn't resume the agent",
    description:
      "You still have the browser, but the message that continues the thread never sent. Retry, or end the takeover and send your own message.",
  },
  fence_failed: {
    title: "Couldn't take the browser from the agent",
    description:
      "Automation is still blocked for this thread. Release the browser lease to let the agent use it again.",
  },
  host_disconnected: {
    title: "The desktop hosting the browser disconnected",
    description:
      "Automation stays blocked until you release it. Release the browser lease to let the agent use it again.",
  },
  interrupt_failed: {
    title: "Couldn't pause the agent",
    description:
      "The browser is still fenced off from the agent. Release the browser lease once the run has stopped.",
  },
  no_live_host: {
    title: "No desktop is hosting this browser",
    description:
      "Pathway could not find the Pathway desktop driving the page, so the agent was not paused. Release the browser lease to clear this.",
  },
  server_restarted: {
    title: "The takeover ended with a server restart",
    description:
      "The server restarted before the agent was paused. Release the browser lease to clear this and start over.",
  },
};

const END_TAKEOVER_ACTION: BrowserTakeoverBannerAction = {
  kind: "release",
  label: "End takeover",
  emphasis: "secondary",
  busy: false,
};

const RELEASE_LEASE_ACTION: BrowserTakeoverBannerAction = {
  kind: "release",
  label: "Release browser lease",
  emphasis: "primary",
  busy: false,
};

/**
 * Single banner slot: the projected takeover always wins, and the invitation to
 * start one only shows when no takeover owns the thread.
 */
export function resolveBrowserTakeoverBanner(
  input: BrowserTakeoverBannerInput,
): BrowserTakeoverBannerDescriptor | null {
  const isDismissed = input.isDismissed ?? isBrowserTakeoverBannerDismissedForSession;
  const takeover = input.takeover ?? null;
  if (takeover !== null && !isBrowserTakeoverSettled(takeover.status)) {
    return resolveActiveTakeoverBanner(input, takeover, isDismissed);
  }
  const calloutKey = browserTakeoverCalloutDismissKey(input.threadKey, input.activeRunId);
  const showCallout = shouldShowBrowserTakeoverCallout({
    previewActivity: input.previewActivity,
    takeoverStatus: takeover?.status ?? null,
    activeRunId: input.activeRunId,
    activeRunStatus: input.activeRunStatus,
    previewSupported: input.previewSupported,
    automationHostClientId: input.automationHostClientId,
    dismissed: isDismissed(calloutKey),
  });
  if (!showCallout) return null;
  return {
    id: `browser-takeover-callout:${input.activeRunId ?? "run"}`,
    tone: "callout",
    variant: "info",
    title: "Take over to assist agent",
    description: "Pause the agent and drive its Preview browser yourself, then hand it back.",
    actions: [
      {
        kind: "take-over",
        label: input.requestPending ? "Taking over..." : "Take over",
        emphasis: "primary",
        busy: input.requestPending,
      },
    ],
    transient: false,
    dismissKey: calloutKey,
    dismissLabel: "Dismiss browser takeover offer",
    takeoverId: null,
  };
}

function resolveActiveTakeoverBanner(
  input: BrowserTakeoverBannerInput,
  takeover: OrchestrationV2BrowserTakeover,
  isDismissed: (key: string | null) => boolean,
): BrowserTakeoverBannerDescriptor | null {
  const id = `browser-takeover:${takeover.id}`;
  const hosting =
    input.automationHostClientId !== null &&
    takeover.hostClientId !== null &&
    input.automationHostClientId === takeover.hostClientId;
  switch (takeover.status) {
    case "requested":
    case "pausing":
      return {
        id,
        tone: "pausing",
        variant: "info",
        title: "Pausing agent...",
        description:
          "Finishing the agent's browser work and stopping the run. The browser is yours as soon as it settles.",
        // Escape hatch: draining and settling are each bounded, but a wedged
        // provider can hold this state for over a minute. The server decider
        // accepts release while pausing, so never leave the user with no exit.
        actions: [END_TAKEOVER_ACTION],
        transient: true,
        dismissKey: null,
        dismissLabel: null,
        takeoverId: takeover.id,
      };
    case "active":
      return {
        id,
        tone: "active",
        variant: "warning",
        title: hosting
          ? "Agent paused — you have control"
          : "Agent paused — the browser is under manual control on another Pathway desktop",
        description: hosting
          ? "Set the page up in the Preview browser, then continue the agent from where you left it."
          : "Prepare the page on the desktop that owns the browser. Proceed when the page is ready.",
        actions: [
          { kind: "proceed", label: "Proceed", emphasis: "primary", busy: false },
          END_TAKEOVER_ACTION,
        ],
        transient: false,
        dismissKey: null,
        dismissLabel: null,
        takeoverId: takeover.id,
      };
    case "proceeding":
      return {
        id,
        tone: "proceeding",
        variant: "info",
        title: "Resuming agent...",
        description: "Handing the browser back and continuing the thread from the page you left.",
        actions: [],
        transient: true,
        dismissKey: null,
        dismissLabel: null,
        takeoverId: takeover.id,
      };
    case "failed": {
      const failure = takeover.failure ?? "fence_failed";
      const copy = FAILURE_COPY[failure];
      if (failure === "already_finished") {
        const dismissKey = browserTakeoverFailureDismissKey(input.threadKey, takeover.id);
        if (isDismissed(dismissKey)) return null;
        return {
          id,
          tone: "finished",
          variant: "info",
          title: copy.title,
          description: copy.description,
          actions: [],
          transient: false,
          dismissKey,
          dismissLabel: "Dismiss browser takeover notice",
          takeoverId: takeover.id,
        };
      }
      return {
        id,
        tone: "failed",
        variant: "error",
        title: copy.title,
        description: copy.description,
        actions:
          failure === "continuation_failed"
            ? [
                { kind: "proceed", label: "Retry", emphasis: "primary", busy: false },
                END_TAKEOVER_ACTION,
              ]
            : [RELEASE_LEASE_ACTION],
        transient: false,
        dismissKey: null,
        dismissLabel: null,
        takeoverId: takeover.id,
      };
    }
    // Settled takeovers never reach here; the caller filters them out.
    case "completed":
    case "cancelled":
      return null;
  }
}

const TONE_ICONS: Record<BrowserTakeoverBannerTone, () => ReactNode> = {
  callout: () => <MousePointerClickIcon />,
  pausing: () => <Spinner />,
  active: () => <HandIcon />,
  proceeding: () => <Spinner />,
  failed: () => <CircleAlertIcon />,
  finished: () => <InfoIcon />,
};

// Clicking a composer banner button must not steal focus from the composer.
const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

export interface BrowserTakeoverBannerHandlers {
  readonly onTakeOver: () => void;
  readonly onProceed: () => void;
  readonly onRelease: () => void;
  readonly onDismiss: () => void;
}

/** Turns a descriptor into the item shape the composer banner stack renders. */
export function browserTakeoverBannerItem(
  descriptor: BrowserTakeoverBannerDescriptor,
  handlers: BrowserTakeoverBannerHandlers,
): ComposerBannerStackItem {
  const onClickFor = (kind: BrowserTakeoverActionKind) => {
    switch (kind) {
      case "take-over":
        return handlers.onTakeOver;
      case "proceed":
        return handlers.onProceed;
      case "release":
        return handlers.onRelease;
    }
  };
  return {
    id: descriptor.id,
    variant: descriptor.variant,
    urgent: descriptor.tone === "active" || descriptor.tone === "failed",
    icon: TONE_ICONS[descriptor.tone](),
    title: descriptor.transient ? <span role="status">{descriptor.title}</span> : descriptor.title,
    description: descriptor.description,
    ...(descriptor.actions.length === 0
      ? {}
      : {
          actions: (
            <>
              {descriptor.actions.map((action) => (
                <Button
                  key={action.kind}
                  size="xs"
                  variant={action.emphasis === "primary" ? "default" : "outline"}
                  disabled={action.busy}
                  onPointerDown={preventPointerFocus}
                  onClick={onClickFor(action.kind)}
                >
                  {action.label}
                </Button>
              ))}
            </>
          ),
        }),
    ...(descriptor.dismissKey === null
      ? {}
      : {
          dismissLabel: descriptor.dismissLabel ?? "Dismiss",
          onDismiss: handlers.onDismiss,
        }),
  };
}
