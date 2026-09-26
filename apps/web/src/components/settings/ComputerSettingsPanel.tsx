// Settings → Computer: the control toggle, the one attention row, cursor colors
// and the preview for the selected environment, followed by the getting-started
// guide, the action history, the access and oversight policy, and the Advanced
// details (macOS grants and what the backend can do).

import { connectionStatusText } from "@spiritdevs/client-runtime/connection";
import {
  AuthAccessReadScope,
  AuthAccessWriteScope,
  DEFAULT_AGENT_CURSOR_COLOR_MODE,
  DEFAULT_CLIENT_SETTINGS,
  normalizeCursorHexColor,
  type ClientSettings,
  type ClientSettingsPatch,
  type ComputerStatusResult,
  type DesktopComputerHelperState,
  type DesktopComputerSettingsPane,
  type EnvironmentId,
} from "@spiritdevs/contracts";
import { ChevronDownIcon, CloudIcon, LaptopIcon, MonitorIcon, TerminalIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { useComputerStateStore, useCachedComputerStatus } from "../../computerStateStore";
import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import { useProvisionComputer } from "../../hooks/useProvisionComputer";
import { useClientSettings, useUpdateClientSettings } from "../../hooks/useSettings";
import {
  COMPUTER_PERMISSION_KINDS,
  readLocalComputerPermissionBridge,
} from "../../lib/computerProvisioning";
import { cn } from "../../lib/utils";
import { computerEnvironment } from "../../state/computer";
import {
  useEnvironments,
  usePrimaryEnvironmentId,
  type EnvironmentPresentation,
} from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentSessionState } from "../../state/session";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ComputerAuditHistorySection } from "./ComputerAuditHistorySection";
import { ComputerEnvironmentPolicySection } from "./ComputerEnvironmentPolicySection";
import { ComputerGettingStarted } from "./ComputerGettingStarted";
import {
  ComputerHostPermissionNote,
  ComputerHostUnavailableNote,
  ComputerPermissionSection,
  useComputerPermissionGuideBridge,
} from "./ComputerPermissionSection";
import {
  BACKEND_DISPLAY_NAMES,
  computerCapabilitiesDescription,
  computerCapabilitySummary,
  environmentSupportsComputer,
  resolveComputerPermissionsView,
  resolveComputerScopeAccess,
  resolveComputerSettingsAttention,
  type ComputerScopeAccess,
  type ComputerSettingsAttention,
} from "./ComputerSettingsPanel.logic";
import {
  buildProviderEnvironmentOptions,
  resolveSelectedProviderEnvironmentId,
} from "./ProviderSettingsPanel.logic";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useComputerStatusRefresh } from "~/hooks/useComputerStatusRefresh";

const selectStatusByEnvironment = (state: {
  readonly statusByEnvironment: Readonly<Record<string, ComputerStatusResult>>;
}) => state.statusByEnvironment;

// ── Environment picker ──────────────────────────────────────────────────

function computerEnvironmentIcon(environment: EnvironmentPresentation) {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return MonitorIcon;
  if (environment.entry.target._tag === "RelayConnectionTarget") return CloudIcon;
  if (environment.entry.target._tag === "SshConnectionTarget") return TerminalIcon;
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return LaptopIcon;
  return CloudIcon;
}

function computerEnvironmentDetail(environment: EnvironmentPresentation): string {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return "Primary device";
  if (environment.relayManaged) return "Pathway Connect";
  if (environment.entry.target._tag === "SshConnectionTarget") return "SSH";
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return "Local device";
  return environment.displayUrl ?? "Remote device";
}

export function ComputerSettingsPanel() {
  const { environments, isReady } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const statusByEnvironment = useComputerStateStore(selectStatusByEnvironment);
  const options = useMemo(
    () =>
      buildProviderEnvironmentOptions(
        environments.filter((environment) =>
          environmentSupportsComputer(
            environment.descriptor?.platform.os,
            statusByEnvironment[environment.environmentId],
          ),
        ),
        primaryEnvironmentId,
      ),
    [environments, primaryEnvironmentId, statusByEnvironment],
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(
    primaryEnvironmentId,
  );
  const effectiveEnvironmentId = resolveSelectedProviderEnvironmentId(
    options,
    selectedEnvironmentId,
    primaryEnvironmentId,
  );
  const selectedEnvironment =
    options.find((environment) => environment.environmentId === effectiveEnvironmentId) ?? null;
  const onlyPrimaryDevice =
    options.length === 1 && options[0]?.entry.target._tag === "PrimaryConnectionTarget";

  return (
    <SettingsPageContainer>
      {!onlyPrimaryDevice ? (
        <SettingsSection title="Devices">
          {options.length === 0 ? (
            <SettingsRow
              title={isReady ? "No Computer-capable devices" : "Loading devices"}
              description={
                isReady
                  ? "Computer control needs an environment running on macOS, or a Wayland desktop on Linux."
                  : "Reading connected execution environments."
              }
            />
          ) : (
            <div className="grid gap-1 sm:grid-cols-2">
              {options.map((environment) => {
                const Icon = computerEnvironmentIcon(environment);
                const selected = environment.environmentId === effectiveEnvironmentId;
                const statusText = connectionStatusText(environment.connection);
                return (
                  <button
                    key={environment.environmentId}
                    type="button"
                    aria-pressed={selected}
                    className={cn(
                      "flex min-w-0 items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors sm:px-4",
                      selected
                        ? "bg-primary/8 ring-1 ring-primary/25 dark:bg-primary/12"
                        : "hover:bg-muted/40",
                    )}
                    onClick={() => setSelectedEnvironmentId(environment.environmentId)}
                  >
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background text-muted-foreground">
                      <Icon className="size-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <ConnectionStatusDot
                          tooltipText={statusText}
                          dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                          pingClassName={connectionPhasePingClassName(environment.connection.phase)}
                        />
                        <span className="truncate text-sm font-medium text-foreground">
                          {environment.label}
                        </span>
                      </span>
                      <span className="block truncate pl-[18px] text-xs text-muted-foreground">
                        {computerEnvironmentDetail(environment)} · {statusText}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </SettingsSection>
      ) : null}

      {selectedEnvironment ? (
        <SelectedComputerEnvironment
          key={selectedEnvironment.environmentId}
          environment={selectedEnvironment}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

// ── Session gating ──────────────────────────────────────────────────────

interface ComputerEnvironmentAccess {
  readonly readAccess: ComputerScopeAccess;
  readonly writeAccess: ComputerScopeAccess;
}

function SelectedComputerEnvironment({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  const isPrimary = environment.entry.target._tag === "PrimaryConnectionTarget";
  if (isPrimary && isElectron) {
    // The desktop app owns its primary server outright.
    return (
      <ComputerEnvironmentSettings
        environment={environment}
        isPrimary
        access={{ readAccess: "granted", writeAccess: "granted" }}
      />
    );
  }
  return isPrimary ? (
    <PrimarySessionGatedComputerSettings environment={environment} />
  ) : (
    <RemoteSessionGatedComputerSettings environment={environment} />
  );
}

function scopeAccess(input: {
  readonly isPrimary: boolean;
  readonly session: Parameters<typeof resolveComputerScopeAccess>[0]["session"];
  readonly isPending: boolean;
  readonly hasError: boolean;
}): ComputerEnvironmentAccess {
  const base = { ...input, isElectron };
  return {
    readAccess: resolveComputerScopeAccess({ ...base, scope: AuthAccessReadScope }),
    writeAccess: resolveComputerScopeAccess({ ...base, scope: AuthAccessWriteScope }),
  };
}

function PrimarySessionGatedComputerSettings({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  const session = usePrimarySessionState();
  return (
    <ComputerEnvironmentSettings
      environment={environment}
      isPrimary
      access={scopeAccess({
        isPrimary: true,
        session: session.data,
        isPending: session.isPending,
        hasError: session.error !== null,
      })}
    />
  );
}

function RemoteSessionGatedComputerSettings({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  const session = useEnvironmentSessionState(environment.environmentId);
  return (
    <ComputerEnvironmentSettings
      environment={environment}
      isPrimary={false}
      access={scopeAccess({
        isPrimary: false,
        session: session.data,
        isPending: session.isPending,
        hasError: session.hasError,
      })}
    />
  );
}

// ── One environment ─────────────────────────────────────────────────────

function ComputerEnvironmentSettings({
  environment,
  isPrimary,
  access,
}: {
  readonly environment: EnvironmentPresentation;
  readonly isPrimary: boolean;
  readonly access: ComputerEnvironmentAccess;
}) {
  const environmentId = environment.environmentId;
  const settings = useClientSettings();
  const updateSettings = useUpdateClientSettings();
  const statusQuery = useEnvironmentQuery(computerEnvironment.status({ environmentId, input: {} }));
  const cachedStatus = useCachedComputerStatus(environmentId);
  const status = cachedStatus ?? statusQuery.data ?? undefined;

  // Every fetched status lands in the shared store, so surfaces that only
  // describe the desktop never have to ask it themselves.
  useEffect(() => {
    if (statusQuery.data) {
      useComputerStateStore.getState().setStatus(environmentId, statusQuery.data);
    }
  }, [environmentId, statusQuery.data]);

  // Grants belong to the host, so only the desktop app's own primary has a
  // native permission surface to consult.
  const bridge = useMemo(
    () =>
      readLocalComputerPermissionBridge({ environmentIsDesktopPrimary: isElectron && isPrimary }),
    [isPrimary],
  );
  const [nativeState, setNativeState] = useState<DesktopComputerHelperState | null>(null);
  const [guidePane, setGuidePane] = useState<DesktopComputerSettingsPane | null>(null);
  const refreshNativeState = useCallback(() => {
    if (!bridge) return;
    void bridge
      .getState(COMPUTER_PERMISSION_KINDS)
      .then(setNativeState)
      .catch(() => undefined);
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    const unsubscribe = bridge.onState((state) => {
      if (!disposed) setNativeState(state);
    });
    void bridge
      .getState(COMPUTER_PERMISSION_KINDS)
      .then((next) => {
        if (!disposed) setNativeState(next);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [bridge]);

  useComputerPermissionGuideBridge({
    bridge,
    permissionKinds: COMPUTER_PERMISSION_KINDS,
    onStateChange: setNativeState,
    onGuidePaneChange: setGuidePane,
  });

  // Returning from System Settings must re-read both the server status and the
  // native grant snapshot; the toggle the user just flipped lives in the second.
  const refreshStatus = statusQuery.refresh;
  useComputerStatusRefresh({
    refreshStatus,
    refreshNativeState,
    paused: statusQuery.error !== null,
  });

  const attention = resolveComputerSettingsAttention({
    status,
    statusError: statusQuery.error,
    nativeState,
    hasNativeBridge: bridge !== null,
  });
  const hasNativePermissionSetup = bridge !== null && nativeState?.supported === true;
  // The same provision the chat's setup card runs: one call in flight per
  // environment, reported inline here instead of as toasts.
  const setup = useProvisionComputer(environmentId, {
    missing: attention.missingPermissions,
  });

  const permissionsView = resolveComputerPermissionsView({
    hasNativeBridge: bridge !== null,
    nativeState,
    platform: environment.descriptor?.platform.os,
  });
  const permissions =
    bridge !== null && permissionsView?.kind === "grants" ? (
      <ComputerPermissionSection
        bridge={bridge}
        permissionKinds={COMPUTER_PERMISSION_KINDS}
        state={permissionsView.state}
        onStateChange={setNativeState}
        guidePane={guidePane}
        onGuidePaneChange={setGuidePane}
      />
    ) : permissionsView?.kind === "unavailable" ? (
      <ComputerHostUnavailableNote message={permissionsView.message} />
    ) : permissionsView?.kind === "host-note" ? (
      <ComputerHostPermissionNote />
    ) : null;

  return (
    <ComputerSettingsView
      settings={settings}
      updateSettings={updateSettings}
      status={status}
      attention={attention}
      setup={setup}
      retry={{
        isChecking: statusQuery.isPending,
        onRetry: () => {
          refreshStatus();
          refreshNativeState();
        },
      }}
      permissions={permissions}
    >
      <ComputerGettingStarted snapShotAvailable={hasNativePermissionSetup} />
      <ComputerAuditHistorySection environmentId={environmentId} readAccess={access.readAccess} />
      <ComputerEnvironmentPolicySection
        environmentId={environmentId}
        writeAccess={access.writeAccess}
      />
    </ComputerSettingsView>
  );
}

// ── The surface ─────────────────────────────────────────────────────────

/**
 * One agent-cursor color field: a validated hex input and the swatch it
 * resolves to. Only a complete `#rrggbb` (or an intentional clear) commits, so
 * a half-typed value never reaches the stored preference.
 */
function CursorColorField({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // Follow a committed value that landed from elsewhere (Reset, another window).
  useEffect(() => setDraft(value), [value]);
  const resolved = normalizeCursorHexColor(value);
  const draftIsValid = draft.trim() === "" || normalizeCursorHexColor(draft) !== "";
  return (
    <label className="flex items-center gap-2">
      <span className="w-7 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span
        aria-hidden
        data-swatch={resolved || "stock"}
        className={cn(
          "size-4 shrink-0 rounded-full border border-border",
          !resolved && "bg-transparent",
        )}
        style={resolved ? { backgroundColor: resolved } : undefined}
      />
      <Input
        size="sm"
        value={draft}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (next.trim() === "") {
            onChange("");
            return;
          }
          const normalized = normalizeCursorHexColor(next);
          if (normalized) onChange(normalized);
        }}
        onBlur={() => setDraft(value)}
        placeholder="#rrggbb"
        maxLength={7}
        spellCheck={false}
        autoComplete="off"
        aria-label={`${label} color`}
        aria-invalid={!draftIsValid}
        className="w-24"
      />
    </label>
  );
}

function SegmentedChoice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly onChange: (value: T) => void;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      className="shrink-0"
      size="sm"
      variant="outline"
      value={[value]}
      onValueChange={(next) => {
        const option = options.find((candidate) => candidate.value === next[0]);
        if (option) onChange(option.value);
      }}
    >
      {options.map((option) => (
        <Toggle key={option.value} value={option.value}>
          {option.label}
        </Toggle>
      ))}
    </ToggleGroup>
  );
}

const ATTENTION_TONE_CLASS: Record<ComputerSettingsAttention["tone"], string> = {
  ready: "bg-emerald-500",
  // Static on purpose: a checking state can last indefinitely.
  checking: "bg-amber-500",
  warning: "bg-amber-500",
  error: "bg-red-500",
};

export type ComputerSettingsViewSettings = Pick<
  ClientSettings,
  | "computerControlEnabled"
  | "autoOpenComputerPane"
  | "computerPreviewSize"
  | "agentCursorColorMode"
  | "agentCursorFillColor"
  | "agentCursorRimColor"
>;

export interface ComputerSettingsViewProps {
  readonly settings: ComputerSettingsViewSettings;
  readonly updateSettings: (patch: ClientSettingsPatch) => void;
  readonly status: ComputerStatusResult | undefined;
  readonly attention: ComputerSettingsAttention;
  readonly setup: {
    readonly provision: () => void;
    readonly isPending: boolean;
    readonly note: string | undefined;
  };
  readonly retry: { readonly isChecking: boolean; readonly onRetry: () => void };
  /** The macOS permission checklist, or where grants are set up instead. */
  readonly permissions: ReactNode;
  /** Sections between the control surface and Advanced. */
  readonly children?: ReactNode;
}

/** Everything the panel decides at render time, with no data fetching of its own. */
export function ComputerSettingsView({
  settings,
  updateSettings,
  status,
  attention,
  setup,
  retry,
  permissions,
  children,
}: ComputerSettingsViewProps) {
  const defaults = DEFAULT_CLIENT_SETTINGS;
  // Details stay out of the way until asked for.
  const [advancedOpen, setAdvancedOpen] = useState(false);

  const attentionAction =
    attention.action === "setup" ? (
      <Button size="sm" variant="outline" disabled={setup.isPending} onClick={setup.provision}>
        {setup.isPending ? "Setting up…" : "Set up"}
      </Button>
    ) : attention.action === "retry" ? (
      <Button size="sm" variant="outline" disabled={retry.isChecking} onClick={retry.onRetry}>
        {retry.isChecking ? "Checking…" : "Check again"}
      </Button>
    ) : null;
  // Stock is the default and stores no override.
  const cursorColorMode = settings.agentCursorColorMode ?? DEFAULT_AGENT_CURSOR_COLOR_MODE;
  const cursorColorsDirty =
    cursorColorMode !== defaults.agentCursorColorMode ||
    (settings.agentCursorFillColor ?? "") !== defaults.agentCursorFillColor ||
    (settings.agentCursorRimColor ?? "") !== defaults.agentCursorRimColor;
  const previewDirty =
    settings.autoOpenComputerPane !== defaults.autoOpenComputerPane ||
    settings.computerPreviewSize !== defaults.computerPreviewSize;

  return (
    <>
      <SettingsSection
        {...searchableSetting("computer-control")}
        headerAction={
          <div className="flex items-center gap-1.5">
            {settings.computerControlEnabled !== defaults.computerControlEnabled ? (
              <SettingResetButton
                label="computer control"
                onClick={() =>
                  updateSettings({ computerControlEnabled: defaults.computerControlEnabled })
                }
              />
            ) : null}
            <Switch
              checked={settings.computerControlEnabled}
              onCheckedChange={(checked) =>
                updateSettings({ computerControlEnabled: Boolean(checked) })
              }
              aria-label="Let the agent use the desktop in any chat"
            />
          </div>
        }
      >
        <p className="@xl/settings:px-4 px-3 text-[13px] text-muted-foreground">
          Enable Computer by default in any chat. Leave this off and use /computer-use for one
          request without adding Computer tools to ordinary turns.
        </p>
        {attention.show ? (
          <SettingsRow
            title={
              <span className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    ATTENTION_TONE_CLASS[attention.tone],
                  )}
                />
                {attention.title}
              </span>
            }
            description={attention.description}
            status={[setup.note, ...attention.notes].filter(Boolean).join(" ") || undefined}
            control={attentionAction}
          />
        ) : null}
        <SettingsRow
          {...searchableSetting("computer-cursor-colors")}
          description="The agent pointer is stock monochrome by default — like a normal pointer. Custom colors apply to new computer sessions."
          resetAction={
            cursorColorsDirty ? (
              <SettingResetButton
                label="cursor colors"
                onClick={() =>
                  updateSettings({
                    agentCursorColorMode: defaults.agentCursorColorMode,
                    agentCursorFillColor: defaults.agentCursorFillColor,
                    agentCursorRimColor: defaults.agentCursorRimColor,
                  })
                }
              />
            ) : null
          }
          control={
            <SegmentedChoice
              label="Agent cursor colors"
              value={cursorColorMode}
              options={[
                { value: "stock", label: "Stock" },
                { value: "custom", label: "Custom" },
              ]}
              onChange={(value) => updateSettings({ agentCursorColorMode: value })}
            />
          }
        >
          {cursorColorMode === "custom" ? (
            <div className="flex flex-col gap-2 pt-3 pb-2 sm:flex-row sm:gap-4">
              <CursorColorField
                label="Fill"
                value={settings.agentCursorFillColor ?? ""}
                onChange={(value) => updateSettings({ agentCursorFillColor: value })}
              />
              <CursorColorField
                label="Rim"
                value={settings.agentCursorRimColor ?? ""}
                onChange={(value) => updateSettings({ agentCursorRimColor: value })}
              />
            </div>
          ) : null}
        </SettingsRow>
        <SettingsRow
          {...searchableSetting("computer-preview")}
          description="Show the live preview the first time an agent acts on the desktop in a chat. Compact keeps it small and glanceable; Large gives it the full wide card."
          resetAction={
            previewDirty ? (
              <SettingResetButton
                label="preview"
                onClick={() =>
                  updateSettings({
                    autoOpenComputerPane: defaults.autoOpenComputerPane,
                    computerPreviewSize: defaults.computerPreviewSize,
                  })
                }
              />
            ) : null
          }
          control={
            <div className="flex items-center gap-3">
              <Switch
                checked={settings.autoOpenComputerPane}
                onCheckedChange={(checked) =>
                  updateSettings({ autoOpenComputerPane: Boolean(checked) })
                }
                aria-label="Show the computer preview automatically when an agent drives the desktop"
              />
              <SegmentedChoice
                label="In-chat computer preview size"
                value={settings.computerPreviewSize}
                options={[
                  { value: "compact", label: "Compact" },
                  { value: "large", label: "Large" },
                ]}
                onChange={(value) => updateSettings({ computerPreviewSize: value })}
              />
            </div>
          }
        />
      </SettingsSection>

      {children}

      <SettingsSection
        title="Advanced"
        headerAction={
          <Button
            size="xs"
            variant="ghost"
            aria-expanded={advancedOpen}
            onClick={() => setAdvancedOpen((open) => !open)}
          >
            <ChevronDownIcon className={cn("size-3.5", advancedOpen && "rotate-180")} aria-hidden />
            {advancedOpen ? "Hide" : "Show"}
          </Button>
        }
      >
        {/* Mounted while hidden so the permission guide keeps its state. */}
        <div hidden={!advancedOpen} className="space-y-4">
          {permissions}
          {status && attention.view.kind === "ready" ? (
            <SettingsRow
              title="Desktop abilities"
              description={computerCapabilitiesDescription(attention.backend, status.capabilities)}
              status={`${attention.backend ? (BACKEND_DISPLAY_NAMES[attention.backend] ?? attention.backend) : "No backend"} · ${computerCapabilitySummary(status.capabilities, !attention.captureBlocked)}`}
            />
          ) : null}
        </div>
      </SettingsSection>
    </>
  );
}
