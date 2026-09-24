// The guided macOS permission checklist for Computer control: per-pane Grant
// buttons that deep-link System Settings, run the floating guide, and poll
// until the grant lands. Desktop app only, and only for the environment the
// desktop app hosts; everywhere else grants are set up on the host machine.

import type {
  DesktopComputerBridge,
  DesktopComputerHelperState,
  DesktopComputerPermissionKind,
  DesktopComputerPermissionState,
  DesktopComputerSettingsPane,
} from "@spiritdevs/contracts";
import { useEffect, useRef } from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { COMPUTER_PANE_LABELS, ComputerPermissionGuide } from "./ComputerPermissionGuide";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export interface ComputerPermissionPaneDescriptor {
  readonly pane: DesktopComputerSettingsPane;
  readonly title: string;
  readonly description: string;
}

/**
 * Computer needs Input Monitoring for Escape and human takeover. The matching
 * kind list lives in `@spiritdevs/shared/computerGrants`.
 */
export const COMPUTER_PERMISSION_PANES: readonly ComputerPermissionPaneDescriptor[] = [
  {
    pane: "accessibility",
    title: "Accessibility",
    description:
      "Lets Pathway move the pointer, click, and type on your behalf. Nothing is driven unless you authorize a Computer task.",
  },
  {
    pane: "screen-recording",
    title: "Screen Recording",
    description:
      "Lets Pathway capture windows and the desktop so the agent can see what it is driving.",
  },
  {
    pane: "input-monitoring",
    title: "Input Monitoring",
    description:
      "Lets Pathway detect Escape and pause when you take over during a Computer task. This does not enable the SnapShot shortcut.",
  },
];

const PERMISSION_LABELS: Record<DesktopComputerPermissionState, string> = {
  granted: "Granted",
  denied: "Denied",
  "not-determined": "Not requested yet",
  restricted: "Restricted",
  unknown: "Unknown",
};

function ComputerPermissionBadge({
  permission,
}: {
  readonly permission: DesktopComputerPermissionState;
}) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
      <span
        aria-hidden
        className={cn(
          "size-1.5 rounded-full",
          permission === "granted"
            ? "bg-emerald-500"
            : permission === "denied" || permission === "restricted"
              ? "bg-red-500"
              : "bg-border",
        )}
      />
      {PERMISSION_LABELS[permission]}
    </span>
  );
}

export function computerPanePermission(
  state: DesktopComputerHelperState,
  pane: DesktopComputerSettingsPane,
): DesktopComputerPermissionState {
  if (pane === "input-monitoring") return state.inputMonitoringPermission;
  if (pane === "accessibility") return state.accessibilityPermission ?? "unknown";
  return state.screenRecordingPermission;
}

/**
 * Keeps the parent-owned guide state honest: a native "granted" refreshes the
 * grant snapshot; a dismissed guide ("closed") clears the remembered pane so it
 * cannot resurrect on the next render.
 */
export function useComputerPermissionGuideBridge({
  bridge,
  permissionKinds,
  onStateChange,
  onGuidePaneChange,
}: {
  readonly bridge: DesktopComputerBridge | null;
  readonly permissionKinds: readonly DesktopComputerPermissionKind[];
  readonly onStateChange: (state: DesktopComputerHelperState) => void;
  readonly onGuidePaneChange: (pane: DesktopComputerSettingsPane | null) => void;
}): void {
  const onStateChangeRef = useRef(onStateChange);
  const onGuidePaneChangeRef = useRef(onGuidePaneChange);
  const permissionKindsRef = useRef(permissionKinds);
  onStateChangeRef.current = onStateChange;
  onGuidePaneChangeRef.current = onGuidePaneChange;
  permissionKindsRef.current = permissionKinds;

  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    const unsubscribe = bridge.onPermissionGuideState((guideState) => {
      if (disposed) return;
      if (guideState === "granted") {
        // Refresh the real grant so the success effect can close the guide.
        void bridge
          .getState(permissionKindsRef.current)
          .then((next) => {
            if (!disposed) onStateChangeRef.current(next);
          })
          .catch(() => undefined);
      } else if (guideState === "closed") {
        // Only the active guide reports, so a stale close cannot close a newer pane.
        onGuidePaneChangeRef.current(null);
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bridge]);
}

/**
 * One row per pane. The parent owns the grant snapshot (the attention row reads
 * it too) and must mount `useComputerPermissionGuideBridge`; this section owns
 * the open guide's polling and the floating guide's visibility.
 */
export function ComputerPermissionSection({
  bridge,
  permissionKinds,
  state,
  onStateChange,
  guidePane,
  onGuidePaneChange,
}: {
  readonly bridge: DesktopComputerBridge;
  readonly permissionKinds: readonly DesktopComputerPermissionKind[];
  readonly state: DesktopComputerHelperState;
  readonly onStateChange: (state: DesktopComputerHelperState) => void;
  readonly guidePane: DesktopComputerSettingsPane | null;
  readonly onGuidePaneChange: (pane: DesktopComputerSettingsPane | null) => void;
}) {
  const onStateChangeRef = useRef(onStateChange);
  onStateChangeRef.current = onStateChange;

  // macOS fires no event when a TCC grant changes, so an open guide polls the
  // helper's preflight until the grant shows up (or the user restarts).
  useEffect(() => {
    if (!guidePane) return;
    let disposed = false;
    const poll = () => {
      void bridge
        .getState(permissionKinds)
        .then((next) => {
          if (!disposed) onStateChangeRef.current(next);
        })
        .catch(() => undefined);
    };
    poll();
    const interval = setInterval(poll, 2_000);
    return () => {
      disposed = true;
      clearInterval(interval);
    };
  }, [bridge, guidePane, permissionKinds]);

  // The floating drag-in guide lives exactly as long as the inline one. Only
  // hide what this surface showed, so mounting cannot close a guide a
  // startPermissionSetup session is still driving.
  const shownGuidePaneRef = useRef<DesktopComputerSettingsPane | null>(null);
  useEffect(() => {
    if (guidePane) {
      shownGuidePaneRef.current = guidePane;
      void bridge.showPermissionGuide(guidePane).catch(() => undefined);
    } else if (shownGuidePaneRef.current) {
      shownGuidePaneRef.current = null;
      void bridge.hidePermissionGuide().catch(() => undefined);
    }
    return () => {
      if (shownGuidePaneRef.current) {
        shownGuidePaneRef.current = null;
        void bridge.hidePermissionGuide().catch(() => undefined);
      }
    };
  }, [bridge, guidePane]);

  useEffect(() => {
    if (!guidePane) return;
    if (computerPanePermission(state, guidePane) !== "granted") return;
    onGuidePaneChange(null);
    toastManager.add({
      type: "success",
      title: "Permission granted",
      description: `${COMPUTER_PANE_LABELS[guidePane]} is ready for Computer control.`,
    });
  }, [guidePane, state, onGuidePaneChange]);

  const openSettings = (pane: DesktopComputerSettingsPane) => {
    void bridge.openPermissionSettings(pane).catch(() => undefined);
  };

  return (
    <SettingsSection title="macOS permissions">
      {COMPUTER_PERMISSION_PANES.map(({ pane, title, description }) => {
        const permission = computerPanePermission(state, pane);
        const guideOpen = guidePane === pane;
        return (
          <SettingsRow
            key={pane}
            title={title}
            description={description}
            control={
              <div className="flex items-center gap-2">
                <ComputerPermissionBadge permission={permission} />
                {permission !== "granted" ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    aria-expanded={guideOpen}
                    onClick={() => {
                      const nextPane = guideOpen ? null : pane;
                      onGuidePaneChange(nextPane);
                      if (nextPane) openSettings(pane);
                    }}
                  >
                    {guideOpen ? "Hide steps" : "Grant"}
                  </Button>
                ) : null}
              </div>
            }
          >
            {guideOpen ? (
              <div className="pt-3 pb-2">
                <ComputerPermissionGuide
                  pane={pane}
                  appDisplayName={state.appDisplayName}
                  waiting={permission !== "granted"}
                  onOpenSettings={() => openSettings(pane)}
                  onRestart={() => {
                    void bridge.restartApp().catch(() => undefined);
                  }}
                />
              </div>
            ) : null}
          </SettingsRow>
        );
      })}
    </SettingsSection>
  );
}

/** Where a browser or a remote environment's grants are set up instead. */
export function ComputerHostPermissionNote() {
  return (
    <SettingsSection title="macOS permissions">
      <SettingsRow
        title="Set up on the host"
        description="Desktop permissions belong to the machine running this environment. Grant them in the Pathway desktop app on that machine, or press Set up above to have the host ask for them."
      />
    </SettingsSection>
  );
}

/** The desktop's own host cannot run Computer; its message says why. */
export function ComputerHostUnavailableNote({ message }: { readonly message: string }) {
  return (
    <SettingsSection title="Desktop permissions">
      <SettingsRow title="Unavailable on this desktop" description={message} />
    </SettingsSection>
  );
}
