// What Settings → Computer says about one environment's desktop: the single
// attention row, the abilities read-out, who may change policy, and the
// ADR 0041–0043 policy copy. Pure so every state the panel can be in is pinned
// by tests without mounting it.

import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  COMPUTER_HYPRLAND_BACKEND,
  COMPUTER_KWIN_BACKEND,
  COMPUTER_MAC_BACKEND,
  COMPUTER_NESTED_KWIN_BACKEND,
  COMPUTER_RELEASE_CONTROL_HOTKEY,
  COMPUTER_RELEASE_HOTKEY_BACKENDS,
  type AuthSessionState,
  type ComputerAccessPolicy,
  type ComputerAutonomy,
  type ComputerAvailability,
  type ComputerCapabilities,
  type ComputerPermission,
  type ComputerStatusResult,
  type DesktopComputerHelperState,
} from "@spiritdevs/contracts";
import {
  computerPermissionSetupMessage,
  missingComputerHelperPermissions,
} from "@spiritdevs/shared/computerGrants";

import { computerReconnectsNote } from "../computer/ComputerPanel.logic";
import {
  computerStatusNeedsSetup,
  resolveComputerAvailabilityView,
  type ComputerAvailabilityView,
} from "../../lib/computerProvisioning";

export const BACKEND_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  [COMPUTER_KWIN_BACKEND]: "KWin plugin (KDE)",
  [COMPUTER_HYPRLAND_BACKEND]: "Hyprland plugin",
  [COMPUTER_NESTED_KWIN_BACKEND]: "Isolated agent desktop (nested KWin)",
  [COMPUTER_MAC_BACKEND]: "macOS desktop",
  cua: "Cua 0.28.2",
  fake: "Test backend",
};

/** Ordered to read as a sentence of abilities, most consequential first. */
const CAPABILITY_LABELS: ReadonlyArray<{
  readonly key: keyof ComputerCapabilities;
  readonly label: string;
}> = [
  { key: "capture", label: "screen capture" },
  { key: "input", label: "input" },
  { key: "windows", label: "window listing" },
  { key: "windowBounds", label: "window geometry" },
  { key: "stacking", label: "stacking order" },
  { key: "focus", label: "keyboard focus" },
  { key: "raise", label: "window raising" },
  { key: "clipboard", label: "clipboard" },
  { key: "ghostCursor", label: "ghost cursor" },
];

/**
 * The abilities to read out. `captureAvailable` is live health, not a static
 * capability: a backend can advertise capture and still be unable to take a
 * frame because the OS has not granted it.
 */
export function computerCapabilitySummary(
  capabilities: ComputerCapabilities,
  captureAvailable: boolean,
): string {
  const enabled = CAPABILITY_LABELS.filter(
    (entry) => capabilities[entry.key] && (entry.key !== "capture" || captureAvailable),
  ).map((entry) => entry.label);
  return enabled.length > 0 ? enabled.join(", ") : "none";
}

/**
 * How this backend shares the machine, in the user's terms. macOS drives the
 * desktop the human is looking at; only a visible compositor-plugin desktop may
 * promise the release hotkey.
 */
export function computerCapabilitiesDescription(
  backend: string | null,
  capabilities: ComputerCapabilities | undefined,
): string {
  if (backend === "cua" && capabilities?.input === false) {
    return "This backend can observe desktop windows, but native desktop input is unavailable. Isolated headless browser actions require a verified browser runtime and an available task-scoped Escape shortcut. Use Stop in the chat to interrupt the task.";
  }
  if (backend === COMPUTER_MAC_BACKEND || backend === "cua") {
    return "The agent shares your Mac desktop and works in the background by default. It can bring a window forward when your task asks to watch. Background input may still affect focus. Use Stop in the chat to interrupt the task. Physical Escape interrupts the current action when Input Monitoring is granted; it does not disable future tasks.";
  }
  if (
    backend !== null &&
    COMPUTER_RELEASE_HOTKEY_BACKENDS.includes(backend) &&
    capabilities?.visibleDesktop === true
  ) {
    return `The agent shares the computer described by this backend. Press ${COMPUTER_RELEASE_CONTROL_HOTKEY} at any time to stop it from acting on the desktop, and press it again to let it resume.`;
  }
  return "The agent drives its own seat, so your cursor and focus stay untouched.";
}

export type ComputerAttentionTone = "ready" | "checking" | "warning" | "error";

export interface ComputerSettingsAttention {
  readonly view: ComputerAvailabilityView;
  readonly show: boolean;
  readonly title: string;
  readonly description: string;
  readonly tone: ComputerAttentionTone;
  /** "setup" offers Set up; "retry" re-reads a status that failed to load. */
  readonly action: "setup" | "retry" | null;
  /** The grants the OS is withholding, named for the provision toast and note. */
  readonly missingPermissions: readonly ComputerPermission[];
  readonly grantsConfirmed: boolean;
  readonly captureBlocked: boolean;
  readonly backend: string | null;
  readonly notes: readonly string[];
  readonly nativePermissionSetupError: string | null;
}

const EMPTY_PERMISSIONS: readonly ComputerPermission[] = [];

/**
 * The one status row. `nativeState` is the desktop app's own grant snapshot,
 * present only when the desktop app speaks for this environment's host.
 */
export function resolveComputerSettingsAttention(input: {
  readonly status: ComputerStatusResult | undefined;
  readonly statusError: string | null;
  readonly nativeState: DesktopComputerHelperState | null;
  /** The desktop bridge exists for this environment, whatever it reported. */
  readonly hasNativeBridge: boolean;
}): ComputerSettingsAttention {
  const { status, nativeState } = input;
  const hasNativePermissionSetup = nativeState?.supported === true;
  const nativePermissionSetupError =
    hasNativePermissionSetup && nativeState.permissionSetupErrorCode ? nativeState.message : null;
  const nativeMissingPermissions =
    hasNativePermissionSetup && nativeState
      ? missingComputerHelperPermissions(nativeState)
      : EMPTY_PERMISSIONS;
  const missingPermissions =
    nativeMissingPermissions.length > 0
      ? nativeMissingPermissions
      : status?.availability.kind === "permission-required"
        ? status.availability.missing
        : EMPTY_PERMISSIONS;
  // macOS itself says every grant is in place: the only thing that lets an idle
  // backend, which has checked nothing since launch, show as ready.
  const grantsConfirmed =
    hasNativePermissionSetup &&
    nativePermissionSetupError === null &&
    nativeMissingPermissions.length === 0;
  // Fresh local grant evidence can reveal setup needs without starting Computer.
  const availability: ComputerAvailability | undefined =
    nativeMissingPermissions.length > 0 && status?.availability.kind === "available"
      ? {
          kind: "permission-required",
          missing: nativeMissingPermissions,
          buildSignature: "unknown",
          message: computerPermissionSetupMessage(nativeMissingPermissions, "unknown"),
        }
      : status?.availability;
  const view: ComputerAvailabilityView =
    input.statusError !== null
      ? {
          kind: "blocked",
          title: "Computer status is unavailable",
          description: input.statusError || "The server could not be reached.",
        }
      : resolveComputerAvailabilityView(availability, status?.health, grantsConfirmed);
  const backend =
    status?.availability.kind === "available" ? (status.availability.backend ?? null) : null;
  const health = status?.health;
  // `captureBlocked` is the refusal itself: a running helper that still cannot
  // see. An idle backend that has not proved capture only earns Set up.
  const captureBlocked = health?.captureAvailable === false && health.status === "connected";
  const localPlatformUnsupported =
    input.hasNativeBridge && nativeState !== null && !nativeState.supported;
  const needsSetup =
    !localPlatformUnsupported &&
    (nativePermissionSetupError !== null ||
      nativeMissingPermissions.length > 0 ||
      computerStatusNeedsSetup(status, grantsConfirmed));
  const show =
    nativePermissionSetupError !== null ||
    view.kind === "ready" ||
    view.kind === "blocked" ||
    (view.kind === "checking" && (needsSetup || health?.status === "reconnecting"));
  const title = nativePermissionSetupError
    ? "Computer permission setup needs attention"
    : captureBlocked
      ? "Screen capture is not allowed yet"
      : view.title;
  const description =
    nativePermissionSetupError ??
    (captureBlocked
      ? backend === COMPUTER_MAC_BACKEND
        ? "The agent can act on the desktop but cannot see it, so screenshots fail. Turn Pathway on in System Settings › Privacy & Security › Screen Recording, then press Set up to reconnect."
        : "The agent can act on the desktop but cannot see it, so screenshots fail. Press Set up to reconnect."
      : view.description);
  const tone: ComputerAttentionTone = nativePermissionSetupError
    ? "error"
    : view.kind === "ready"
      ? "ready"
      : view.kind === "checking"
        ? "checking"
        : captureBlocked
          ? "warning"
          : "error";
  const action = input.statusError !== null ? "retry" : needsSetup ? "setup" : null;
  return {
    view,
    show,
    title,
    description,
    tone,
    action,
    missingPermissions,
    grantsConfirmed,
    captureBlocked,
    backend,
    notes: [computerReconnectsNote(health)].filter((note): note is string => note !== null),
    nativePermissionSetupError,
  };
}

// ── Access ─────────────────────────────────────────────────────────────

/** Whether this client's session on an environment holds a scope. */
export type ComputerScopeAccess = "granted" | "denied" | "pending";

/**
 * Mirrors the provider panel's operate gating for any scope. The desktop app
 * owns its primary server outright. A browser on the primary must be granted
 * the scope explicitly (that server always reports scopes). A remote server
 * that predates scope reporting stays optimistic. A failed session read stays
 * pending, so the policy controls never unlock on a guess.
 */
export function resolveComputerScopeAccess(input: {
  readonly scope: typeof AuthAccessReadScope | typeof AuthAccessWriteScope;
  readonly isPrimary: boolean;
  readonly isElectron: boolean;
  readonly session: Pick<AuthSessionState, "authenticated" | "scopes"> | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
}): ComputerScopeAccess {
  if (input.isPrimary && input.isElectron) return "granted";
  if (input.session === null) {
    if (input.isPending) return "pending";
    return input.hasError ? "pending" : "denied";
  }
  if (!input.session.authenticated) return "denied";
  if (input.session.scopes === undefined) return input.isPrimary ? "denied" : "granted";
  return input.session.scopes.includes(input.scope) ? "granted" : "denied";
}

/**
 * What fills the permissions slot. The desktop's own host shows its grants
 * once the helper answers, or the reason it cannot run (for example, Computer
 * not enabled on this build). A client without the desktop bridge is pointed
 * at the Mac host.
 */
export type ComputerPermissionsView =
  | { readonly kind: "grants"; readonly state: DesktopComputerHelperState }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "host-note" }
  | null;

export function resolveComputerPermissionsView(input: {
  readonly hasNativeBridge: boolean;
  readonly nativeState: DesktopComputerHelperState | null;
  readonly platform: string | undefined;
}): ComputerPermissionsView {
  const { nativeState } = input;
  if (!input.hasNativeBridge) return input.platform === "darwin" ? { kind: "host-note" } : null;
  if (nativeState === null) return null;
  if (nativeState.supported) return { kind: "grants", state: nativeState };
  return nativeState.message ? { kind: "unavailable", message: nativeState.message } : null;
}

// ── Environments ───────────────────────────────────────────────────────

const COMPUTER_CAPABLE_PLATFORMS: ReadonlySet<string> = new Set(["darwin", "linux"]);

/**
 * `useComputerSupport` for a list: the server platform can host a desktop, and
 * no fetched status has said otherwise. Never asks the desktop itself.
 */
export function environmentSupportsComputer(
  platform: string | undefined,
  cachedStatus: ComputerStatusResult | undefined,
): boolean {
  if (platform === undefined || !COMPUTER_CAPABLE_PLATFORMS.has(platform)) return false;
  return cachedStatus?.availability.kind !== "unsupported-platform";
}

// ── Policy copy (ADR 0041–0043) ────────────────────────────────────────

export interface ComputerPolicyOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly description: string;
}

export const COMPUTER_ACCESS_POLICY_OPTIONS: readonly ComputerPolicyOption<ComputerAccessPolicy>[] =
  [
    {
      value: "any-operator",
      label: "Any operator",
      description: "Any paired client that can operate threads can start Computer tasks.",
    },
    {
      value: "scoped",
      label: "Scoped",
      description:
        "Only clients granted Computer access can start Computer tasks. Revoke it per client in Settings → Connections.",
    },
    {
      value: "admins-only",
      label: "Admins only",
      description: "Only admin clients can start Computer tasks.",
    },
  ];

export const COMPUTER_AUTONOMY_OPTIONS: readonly ComputerPolicyOption<ComputerAutonomy>[] = [
  {
    value: "supervised",
    label: "Supervised",
    description: "Every desktop action needs your approval.",
  },
  {
    value: "per-task",
    label: "Per task",
    description: "Approve once per task and once for each additional app.",
  },
  {
    value: "auto",
    label: "Auto",
    description: "No task or app approvals. Foreground use and clipboard reads still ask.",
  },
  {
    value: "full-access",
    label: "Full access",
    description:
      "No approvals. Foreground use and clipboard reads are allowed, and scheduled tasks and subagents can use the computer.",
  },
];

export function computerPolicyOption<T extends string>(
  options: readonly ComputerPolicyOption<T>[],
  value: T,
): ComputerPolicyOption<T> | undefined {
  return options.find((option) => option.value === value);
}

/** Above Synara's default of one approval per task, oversight is reduced. */
export function computerAutonomyReducesOversight(autonomy: ComputerAutonomy): boolean {
  return autonomy === "auto" || autonomy === "full-access";
}
