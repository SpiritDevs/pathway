import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@spiritdevs/contracts";
import { ThreadId } from "@spiritdevs/contracts";
import {
  environmentCommandPermission,
  type EnvironmentCommandKind,
} from "@spiritdevs/contracts/cloudProject";
import {
  CheckIcon,
  ChevronRightIcon,
  CircleStopIcon,
  CopyIcon,
  InfoIcon,
  KeyRoundIcon,
  MessageSquareIcon,
  MonitorIcon,
  MoreVerticalIcon,
  RefreshCwIcon,
  SendIcon,
  ServerIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import * as Effect from "effect/Effect";

import type {
  EnvironmentCommandRecord,
  IssuedConnectGrant,
} from "../../../cloud/environmentControl";
import { environmentCatalog } from "../../../connection/catalog";
import { writeTextToClipboard } from "../../../hooks/useCopyToClipboard";
import { PrimaryEnvironmentHttpClient } from "../../../environments/primary/httpClient";
import { runPrimaryHttp } from "../../../lib/runtime";
import { primaryEnvironmentIdAtom } from "../../../state/primaryEnvironment";
import { useEnvironments } from "../../../state/environments";
import { formatRelativeTimeLabel, formatRelativeTimeUntilLabel } from "../../../timestampFormat";
import { usePrimaryCloudLinkState } from "../../../cloud/primaryCloudLinkState";
import {
  requestAlwaysOnCloudLinkRetry,
  useAlwaysOnCloudLinkStatus,
} from "../../../cloud/useCloudLinkController";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../ui/alert-dialog";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../../ui/collapsible";
import { Input } from "../../ui/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../../ui/select";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPanel,
  SheetPopup,
  SheetTitle,
} from "../../ui/sheet";
import { Textarea } from "../../ui/textarea";
import { EnvironmentConnectionSettings } from "../ConnectionsSettings";
import { partitionEnvironmentsByConnection } from "../ConnectionsSettings.logic";
import { SettingsPageContainer, SettingsSection } from "../settingsLayout";
import { permissionGate } from "./companySettings.logic";
import {
  CompanySectionCard,
  CompanySettingsEmptyState,
  PermissionTooltip,
} from "./CompanySettingsShared";
import {
  deleteConfirmationSecondsRemaining,
  derivePathwayConnectStatus,
  deriveEnvironmentRows,
  deriveRecentEnvironmentCommands,
  environmentCommandSummary,
  environmentRegistrationsFromReplicaValues,
  resolveDeleteConfirmationClick,
  type CompanyEnvironmentRow,
  type PathwayConnectStatus,
} from "./environmentSettings.logic";
import { useCompanySettings } from "./useCompanySettings";
import { useEnvironmentControl } from "./useEnvironmentControl";

const COMMAND_KINDS: ReadonlyArray<{
  readonly kind: EnvironmentCommandKind;
  readonly label: string;
}> = [
  { kind: "startThread", label: "Start thread" },
  { kind: "sendMessage", label: "Send message" },
  { kind: "interrupt", label: "Interrupt" },
  { kind: "statusQuery", label: "Check status" },
];

function relativeTimestamp(timestamp: number | null): string {
  return timestamp === null
    ? "Never"
    : formatRelativeTimeLabel(new Date(timestamp).toISOString()) || "Unknown";
}

function registrationStateBadge(row: CompanyEnvironmentRow) {
  return row.registration.state === "active" ? (
    <Badge variant="success">Active</Badge>
  ) : (
    <Badge variant="secondary">Revoked</Badge>
  );
}

const PATHWAY_CONNECT_BADGE = {
  active: { label: "active", variant: "success", orbClassName: "bg-success" },
  connecting: { label: "connecting", variant: "warning", orbClassName: "bg-warning" },
  failed: { label: "failed", variant: "error", orbClassName: "bg-destructive" },
} as const satisfies Record<
  PathwayConnectStatus,
  {
    readonly label: string;
    readonly variant: "success" | "warning" | "error";
    readonly orbClassName: string;
  }
>;

function PathwayConnectBadge({ status }: { readonly status: PathwayConnectStatus }) {
  const presentation = PATHWAY_CONNECT_BADGE[status];
  return (
    <Badge variant={presentation.variant} aria-label={`Pathway Connect: ${presentation.label}`}>
      <span aria-hidden className={`size-1.5 rounded-full ${presentation.orbClassName}`} />
      Pathway Connect
    </Badge>
  );
}

function commandStateBadge(state: EnvironmentCommandRecord["state"]) {
  if (state === "succeeded") return <Badge variant="success">Succeeded</Badge>;
  if (state === "failed") return <Badge variant="error">Failed</Badge>;
  if (state === "pending") return <Badge variant="warning">Pending</Badge>;
  if (state === "claimed") return <Badge variant="info">Claimed</Badge>;
  return <Badge variant="secondary">{state === "canceled" ? "Canceled" : "Expired"}</Badge>;
}

function EnvironmentList({
  connectedRows,
  disconnectedRows,
  ownManagedEndpointAvailable,
  ownCloudLinkPhase,
  ownCloudLinkError,
  deleteEnabled,
  deleteTooltip,
  deletingEnvironmentId,
  onInfo,
  onDelete,
  onDeleteAllDisconnected,
}: {
  readonly connectedRows: ReadonlyArray<CompanyEnvironmentRow>;
  readonly disconnectedRows: ReadonlyArray<CompanyEnvironmentRow>;
  readonly ownManagedEndpointAvailable: boolean | null;
  readonly ownCloudLinkPhase: "idle" | "connecting" | "waiting" | "connected" | "exhausted";
  readonly ownCloudLinkError: string | null;
  readonly deleteEnabled: boolean;
  readonly deleteTooltip: string | null;
  readonly deletingEnvironmentId: EnvironmentId | null;
  readonly onInfo: (environmentId: EnvironmentId) => void;
  readonly onDelete: (environment: CompanyEnvironmentRow) => void;
  readonly onDeleteAllDisconnected: () => void;
}) {
  const [disconnectedOpen, setDisconnectedOpen] = useState(false);
  const [removeAllOpen, setRemoveAllOpen] = useState(false);
  const rows = [...connectedRows, ...disconnectedRows];
  const renderRow = (row: CompanyEnvironmentRow) => (
    <EnvironmentListRow
      key={row.registration.id}
      row={row}
      ownManagedEndpointAvailable={ownManagedEndpointAvailable}
      ownCloudLinkPhase={ownCloudLinkPhase}
      ownCloudLinkError={ownCloudLinkError}
      deleteEnabled={deleteEnabled}
      deleteTooltip={deleteTooltip}
      deleting={deletingEnvironmentId === row.environmentId}
      onInfo={() => onInfo(row.environmentId)}
      onDelete={() => onDelete(row)}
    />
  );

  return (
    <CompanySectionCard>
      {rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm text-muted-foreground">
          No environments are registered with this company.
        </div>
      ) : (
        <>
          <div className="flex min-h-9 items-center gap-2 border-b px-4 text-xs font-medium text-muted-foreground">
            <span>Connected</span>
            <span className="tabular-nums text-muted-foreground/60">{connectedRows.length}</span>
          </div>
          {connectedRows.length > 0 ? (
            connectedRows.map(renderRow)
          ) : (
            <p className="border-b px-4 py-4 text-xs text-muted-foreground/70">
              No environments are connected.
            </p>
          )}
          {disconnectedRows.length > 0 ? (
            <Collapsible open={disconnectedOpen} onOpenChange={setDisconnectedOpen}>
              <div className="flex min-h-11 items-center justify-between gap-3 px-4">
                <CollapsibleTrigger className="group flex min-w-0 flex-1 items-center gap-2 rounded-sm py-1 text-left text-xs font-medium text-muted-foreground outline-hidden ring-ring hover:text-foreground focus-visible:ring-2">
                  <ChevronRightIcon
                    aria-hidden
                    className="size-3.5 shrink-0 transition-transform duration-200 group-data-panel-open:rotate-90 motion-reduce:transition-none"
                  />
                  <span>Disconnected</span>
                  <span className="tabular-nums text-muted-foreground/60">
                    {disconnectedRows.length}
                  </span>
                </CollapsibleTrigger>
                <AlertDialog open={removeAllOpen} onOpenChange={setRemoveAllOpen}>
                  <AlertDialogTrigger
                    render={
                      <Button
                        size="xs"
                        variant="destructive-outline"
                        disabled={!deleteEnabled || deletingEnvironmentId !== null}
                      />
                    }
                  >
                    Remove all
                  </AlertDialogTrigger>
                  <AlertDialogPopup>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove disconnected environments?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This removes {disconnectedRows.length} disconnected{" "}
                        {disconnectedRows.length === 1 ? "environment" : "environments"} from the
                        workspace. Their server data will not be deleted.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogClose render={<Button variant="outline" />}>
                        Cancel
                      </AlertDialogClose>
                      <Button
                        variant="destructive"
                        onClick={() => {
                          setRemoveAllOpen(false);
                          onDeleteAllDisconnected();
                        }}
                      >
                        Remove all
                      </Button>
                    </AlertDialogFooter>
                  </AlertDialogPopup>
                </AlertDialog>
              </div>
              <CollapsiblePanel>
                <div className="border-t">{disconnectedRows.map(renderRow)}</div>
              </CollapsiblePanel>
            </Collapsible>
          ) : null}
        </>
      )}
    </CompanySectionCard>
  );
}

const DELETE_CONFIRMATION_DURATION_MS = 5_000;

function EnvironmentListRow({
  row,
  ownManagedEndpointAvailable,
  ownCloudLinkPhase,
  ownCloudLinkError,
  deleteEnabled,
  deleteTooltip,
  deleting,
  onInfo,
  onDelete,
}: {
  readonly row: CompanyEnvironmentRow;
  readonly ownManagedEndpointAvailable: boolean | null;
  readonly ownCloudLinkPhase: "idle" | "connecting" | "waiting" | "connected" | "exhausted";
  readonly ownCloudLinkError: string | null;
  readonly deleteEnabled: boolean;
  readonly deleteTooltip: string | null;
  readonly deleting: boolean;
  readonly onInfo: () => void;
  readonly onDelete: () => void;
}) {
  const [deleteArmedUntil, setDeleteArmedUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const deleteSecondsRemaining = deleteConfirmationSecondsRemaining(deleteArmedUntil, now);

  useEffect(() => {
    if (deleteArmedUntil === null) return;
    const update = () => {
      const nextNow = Date.now();
      if (nextNow >= deleteArmedUntil) {
        setDeleteArmedUntil(null);
        return;
      }
      setNow(nextNow);
    };
    const interval = window.setInterval(update, 250);
    return () => window.clearInterval(interval);
  }, [deleteArmedUntil]);

  const managedEndpointAvailable =
    row.isOwnEnvironment && ownManagedEndpointAvailable !== null
      ? ownManagedEndpointAvailable
      : row.registration.managedEndpointAvailable;
  const pathwayConnectStatus = derivePathwayConnectStatus({
    row,
    ownCloudLinkPhase,
    ownManagedEndpointAvailable: managedEndpointAvailable,
    ownCloudLinkError,
  });

  return (
    <div className="flex w-full gap-3 border-b px-4 py-4 last:border-b-0 sm:items-start">
      <div className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
        {row.isOwnEnvironment ? (
          <MonitorIcon className="size-4" />
        ) : (
          <ServerIcon className="size-4" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{row.label}</span>
          {row.isOwnEnvironment ? <Badge variant="info">This device</Badge> : null}
          {registrationStateBadge(row)}
          <PathwayConnectBadge status={pathwayConnectStatus} />
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            {row.registration.descriptor.platform.os}/{row.registration.descriptor.platform.arch} ·
            server {row.registration.descriptor.serverVersion}
          </span>
          <span>
            {row.isInCatalog
              ? row.catalogSource === "local"
                ? "Present in local catalog"
                : "Discovered in company catalog"
              : "Not present in connection catalog"}
          </span>
        </div>
        {row.teamNames.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {row.teamNames.map((teamName) => (
              <Badge key={teamName} variant="outline">
                {teamName}
              </Badge>
            ))}
          </div>
        ) : null}
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger
          aria-label={`Actions for ${row.label}`}
          className="-mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <MoreVerticalIcon className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem onClick={onInfo}>
            <InfoIcon />
            Info
          </DropdownMenuItem>
          {!row.isOwnEnvironment ? (
            <DropdownMenuItem
              closeOnClick={deleteSecondsRemaining !== null}
              disabled={!deleteEnabled || deleting}
              title={deleteTooltip ?? undefined}
              variant="destructive"
              onClick={() => {
                const clickTime = Date.now();
                const result = resolveDeleteConfirmationClick(
                  deleteArmedUntil,
                  clickTime,
                  DELETE_CONFIRMATION_DURATION_MS,
                );
                setNow(clickTime);
                setDeleteArmedUntil(result.armedUntil);
                if (!result.confirmed) {
                  return;
                }
                onDelete();
              }}
            >
              <Trash2Icon />
              {deleting
                ? "Deleting…"
                : deleteSecondsRemaining === null
                  ? "Delete"
                  : `Click again to delete · ${deleteSecondsRemaining}s`}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function GrantReveal({
  grant,
  onDismiss,
  onError,
}: {
  readonly grant: IssuedConnectGrant;
  readonly onDismiss: () => void;
  readonly onError: (message: string) => void;
}) {
  const [copied, setCopied] = useState(false);
  const expiryIso = new Date(grant.expiresAt).toISOString();

  return (
    <div className="space-y-3 rounded-lg border border-warning/30 bg-warning/5 p-3">
      <div className="space-y-1">
        <p className="text-xs font-medium">One-time connect grant</p>
        <p className="text-[11px] text-muted-foreground">
          Expires {formatRelativeTimeUntilLabel(expiryIso)} ·{" "}
          {new Date(grant.expiresAt).toLocaleString()}
        </p>
      </div>
      <code className="block max-h-24 overflow-auto break-all rounded-md bg-background p-2 text-[11px]">
        {grant.token}
      </code>
      <div className="flex items-center gap-2">
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            void writeTextToClipboard(grant.token, "connect grant token").then(
              () => setCopied(true),
              (error) =>
                onError(error instanceof Error ? error.message : "Could not copy the grant token."),
            );
          }}
        >
          {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          {copied ? "Copied" : "Copy token"}
        </Button>
        <Button size="xs" variant="ghost" onClick={onDismiss}>
          Dismiss
        </Button>
      </div>
    </div>
  );
}

function RemoteCommandForm({
  environment,
  issuePending,
  actionBlocked,
  controlAvailable,
  dispatchGate,
  controlGate,
  readGate,
  onIssue,
}: {
  readonly environment: CompanyEnvironmentRow;
  readonly issuePending: boolean;
  readonly actionBlocked: boolean;
  readonly controlAvailable: boolean;
  readonly dispatchGate: { readonly enabled: boolean; readonly tooltip: string | null };
  readonly controlGate: { readonly enabled: boolean; readonly tooltip: string | null };
  readonly readGate: { readonly enabled: boolean; readonly tooltip: string | null };
  readonly onIssue: (input: {
    readonly kind: EnvironmentCommandKind;
    readonly prompt: string;
    readonly threadId: string;
    readonly message: string;
  }) => Promise<boolean>;
}) {
  const [kind, setKind] = useState<EnvironmentCommandKind>("startThread");
  const [prompt, setPrompt] = useState("");
  const [threadId, setThreadId] = useState("");
  const [message, setMessage] = useState("");
  const needsThread = kind !== "startThread";
  const valid =
    kind === "startThread"
      ? prompt.trim().length > 0
      : threadId.trim().length > 0 && (kind !== "sendMessage" || message.trim().length > 0);
  const kindGate =
    environmentCommandPermission(kind) === "environments.read" ? readGate : controlGate;
  const enabled = controlAvailable && dispatchGate.enabled && kindGate.enabled;
  const tooltip = dispatchGate.tooltip ?? kindGate.tooltip;

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-medium">Durable remote command</p>
          <p className="text-xs text-muted-foreground">
            Commands remain pending while {environment.label} is offline and expire after 24 hours.
          </p>
        </div>
        <Select
          value={kind}
          onValueChange={(value) => {
            if (value !== null) setKind(value as EnvironmentCommandKind);
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            {COMMAND_KINDS.map((option) => (
              <SelectItem key={option.kind} value={option.kind}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>

      {kind === "startThread" ? (
        <Textarea
          value={prompt}
          rows={3}
          placeholder="What should the remote agent do?"
          onChange={(event) => setPrompt(event.currentTarget.value)}
        />
      ) : (
        <Input
          value={threadId}
          placeholder="Thread ID"
          onChange={(event) => setThreadId(event.currentTarget.value)}
        />
      )}
      {kind === "sendMessage" ? (
        <Textarea
          value={message}
          rows={3}
          placeholder="Message to send"
          onChange={(event) => setMessage(event.currentTarget.value)}
        />
      ) : null}

      <PermissionTooltip tooltip={tooltip}>
        <Button
          size="sm"
          disabled={!enabled || !valid || actionBlocked}
          onClick={() => {
            void onIssue({ kind, prompt, threadId, message }).then((issued) => {
              if (!issued) return;
              if (kind === "startThread") setPrompt("");
              if (kind === "sendMessage") setMessage("");
            });
          }}
        >
          {kind === "interrupt" ? (
            <CircleStopIcon className="size-3.5" />
          ) : kind === "sendMessage" ? (
            <MessageSquareIcon className="size-3.5" />
          ) : (
            <SendIcon className="size-3.5" />
          )}
          {issuePending ? "Issuing…" : COMMAND_KINDS.find((option) => option.kind === kind)?.label}
        </Button>
      </PermissionTooltip>
      {needsThread ? (
        <p className="text-[11px] text-muted-foreground">
          This command targets the thread ID owned by the remote environment.
        </p>
      ) : null}
    </div>
  );
}

function CommandHistory({
  commands,
  loading,
  error,
  pendingAction,
  cancelEnabled,
  cancelTooltip,
  onRefresh,
  onCancel,
}: {
  readonly commands: ReadonlyArray<EnvironmentCommandRecord>;
  readonly loading: boolean;
  readonly error: string | null;
  readonly pendingAction: string | null;
  readonly cancelEnabled: boolean;
  readonly cancelTooltip: string | null;
  readonly onRefresh: () => void;
  readonly onCancel: (command: EnvironmentCommandRecord) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Recent commands</p>
          <p className="text-xs text-muted-foreground">
            Live updates from the company control plane.
          </p>
        </div>
        <Button size="xs" variant="outline" disabled={loading} onClick={onRefresh}>
          <RefreshCwIcon className="size-3" /> Refresh
        </Button>
      </div>
      {error ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      ) : null}
      <div className="overflow-hidden rounded-lg border">
        {commands.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs text-muted-foreground">
            No commands have been issued to this environment.
          </div>
        ) : (
          commands.map((command) => (
            <div
              key={command.id}
              className="flex flex-col gap-2 border-b px-3 py-3 last:border-b-0 sm:flex-row sm:items-start"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-medium">{command.kind}</span>
                  {commandStateBadge(command.state)}
                  <span className="text-[11px] text-muted-foreground">
                    Issued {relativeTimestamp(command.createdAt)} · Last status{" "}
                    {relativeTimestamp(command.updatedAt)}
                  </span>
                </div>
                <p
                  className={`break-words text-xs ${command.error ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {environmentCommandSummary(command)}
                </p>
              </div>
              {command.state === "pending" ? (
                <PermissionTooltip tooltip={cancelTooltip}>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={!cancelEnabled || pendingAction !== null}
                    onClick={() => onCancel(command)}
                  >
                    {pendingAction === `cancel:${command.id}` ? "Canceling…" : "Cancel"}
                  </Button>
                </PermissionTooltip>
              ) : null}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function CompanyEnvironmentsPanel() {
  const settings = useCompanySettings();
  const control = useEnvironmentControl();
  const { environments } = useEnvironments();
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const ownEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const primaryCloudLinkState = usePrimaryCloudLinkState();
  const cloudLinkStatus = useAlwaysOnCloudLinkStatus();
  const ownManagedEndpointAvailable = primaryCloudLinkState.data
    ? (primaryCloudLinkState.data.managedTunnelActive ?? primaryCloudLinkState.data.linked)
    : null;
  const registrations = useMemo(
    () => environmentRegistrationsFromReplicaValues(settings.replica?.view.values() ?? []),
    [settings.replica],
  );
  const rows = useMemo(
    () =>
      deriveEnvironmentRows({
        registrations,
        catalogEntries: catalog.entries,
        teams: settings.directory.teams,
        ownEnvironmentId,
      }),
    [catalog.entries, ownEnvironmentId, registrations, settings.directory.teams],
  );
  const companyEnvironmentsByConnection = useMemo(() => {
    const connectionByEnvironmentId = new Map(
      environments.map((environment) => [environment.environmentId, environment.connection]),
    );
    const partitioned = partitionEnvironmentsByConnection(
      rows.map((row) => ({
        row,
        connection: connectionByEnvironmentId.get(row.environmentId) ?? { phase: "offline" },
      })),
    );
    return {
      connected: partitioned.connected.map(({ row }) => row),
      disconnected: partitioned.disconnected.map(({ row }) => row),
    };
  }, [environments, rows]);
  const registeredEnvironmentIds = useMemo(
    () => new Set(rows.map((row) => row.environmentId)),
    [rows],
  );
  const [selectedEnvironmentId, setSelectedEnvironmentId] = useState<EnvironmentId | null>(null);
  const [environmentInfoOpen, setEnvironmentInfoOpen] = useState(false);
  const [commands, setCommands] = useState<ReadonlyArray<EnvironmentCommandRecord>>([]);
  const [commandLoadError, setCommandLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loadingCommands, setLoadingCommands] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [grant, setGrant] = useState<IssuedConnectGrant | null>(null);

  useEffect(() => {
    if (
      selectedEnvironmentId === null ||
      rows.some((row) => row.environmentId === selectedEnvironmentId)
    )
      return;
    setSelectedEnvironmentId(null);
    setEnvironmentInfoOpen(false);
  }, [rows, selectedEnvironmentId]);

  useEffect(() => {
    setGrant(null);
    setActionError(null);
  }, [selectedEnvironmentId]);

  useEffect(() => {
    setCommands([]);
    setCommandLoadError(null);
    if (control === null || settings.companyId === null) return;
    return control.subscribeCommands(
      settings.companyId,
      (next) => {
        setCommands(next);
        setCommandLoadError(null);
      },
      (error) => setCommandLoadError(error.message),
    );
  }, [control, settings.companyId]);

  const refreshCommands = useCallback(async () => {
    if (control === null || settings.companyId === null) return;
    setLoadingCommands(true);
    try {
      setCommands(await control.listCommands(settings.companyId));
      setCommandLoadError(null);
    } catch (error) {
      setCommandLoadError(error instanceof Error ? error.message : "Could not load commands.");
    } finally {
      setLoadingCommands(false);
    }
  }, [control, settings.companyId]);

  const selected = rows.find((row) => row.environmentId === selectedEnvironmentId) ?? null;
  const selectedPathwayConnectStatus = selected
    ? derivePathwayConnectStatus({
        row: selected,
        ownCloudLinkPhase: cloudLinkStatus.phase,
        ownManagedEndpointAvailable,
        ownCloudLinkError: primaryCloudLinkState.error ?? cloudLinkStatus.error,
      })
    : null;
  const recentCommands =
    selectedEnvironmentId === null
      ? []
      : deriveRecentEnvironmentCommands(commands, selectedEnvironmentId);
  const readGate = permissionGate(settings.permissions, "environments.read");
  const dispatchGate = permissionGate(settings.permissions, "remoteAgents.dispatch");
  const controlGate = permissionGate(settings.permissions, "remoteAgents.control");
  const manageGate = permissionGate(settings.permissions, "environments.manage");
  const ownRegistration =
    ownEnvironmentId === null
      ? null
      : (registrations.find(
          (registration) =>
            registration.environmentId === ownEnvironmentId && registration.state === "active",
        ) ?? null);
  const serviceRole = [...settings.directory.roles]
    .filter(
      (role) =>
        role.permissions.includes("company.read") &&
        role.permissions.includes("projects.read") &&
        role.permissions.includes("issues.read") &&
        role.permissions.includes("workflow.manage") &&
        role.permissions.includes("environments.read"),
    )
    .toSorted((left, right) => left.permissions.length - right.permissions.length)[0];
  const cancelEnabled = dispatchGate.enabled && control !== null;

  const runAction = async (key: string, action: () => Promise<void>): Promise<boolean> => {
    if (pendingAction !== null) return false;
    setPendingAction(key);
    setActionError(null);
    try {
      await action();
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "The environment action failed.");
      return false;
    } finally {
      setPendingAction(null);
    }
  };

  if (settings.isAuthLoaded && !settings.isSignedIn) {
    return (
      <SettingsPageContainer>
        <EnvironmentConnectionSettings />
        <CompanySettingsEmptyState
          title="Sign in to manage environments"
          description="Environment discovery and remote control are available after you sign in."
        />
      </SettingsPageContainer>
    );
  }
  if (settings.activeCompany === null || settings.companyId === null) {
    return (
      <SettingsPageContainer>
        <EnvironmentConnectionSettings />
        <CompanySettingsEmptyState
          title="Workspace setup is still finishing"
          description="Pathway is preparing your workspace and will connect this environment automatically."
        />
      </SettingsPageContainer>
    );
  }
  if (settings.replica === null) {
    return (
      <SettingsPageContainer>
        <EnvironmentConnectionSettings />
        <CompanySettingsEmptyState
          title="Workspace data is syncing"
          description="Environment settings will appear when this workspace is ready."
        />
      </SettingsPageContainer>
    );
  }

  const companyId = settings.companyId;

  return (
    <SettingsPageContainer>
      <EnvironmentConnectionSettings
        excludeEnvironmentIds={registeredEnvironmentIds}
        renderEnvironmentSection={({ addEnvironmentAction, savedEnvironmentRows }) => (
          <SettingsSection
            id="company-environments"
            title="Environments"
            icon={<ServerIcon className="size-4" />}
            headerAction={addEnvironmentAction}
          >
            {ownEnvironmentId !== null && ownRegistration === null ? (
              <CompanySectionCard>
                <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="text-sm font-medium">Connecting this environment</p>
                    <p className="text-xs text-muted-foreground">
                      Pathway is connecting this server to your workspace automatically.
                    </p>
                  </div>
                  <PermissionTooltip tooltip={manageGate.tooltip}>
                    <Button
                      size="sm"
                      disabled={
                        !manageGate.enabled ||
                        control === null ||
                        serviceRole === undefined ||
                        pendingAction !== null
                      }
                      onClick={() => {
                        if (control === null || serviceRole === undefined) return;
                        void runAction("register", async () => {
                          const info = await runPrimaryHttp(
                            PrimaryEnvironmentHttpClient.pipe(
                              Effect.flatMap((client) =>
                                client.connect.registrationInfo({ headers: {} }),
                              ),
                            ),
                          );
                          await control.registerEnvironment({
                            companyId,
                            info,
                            serviceRoleIds: [serviceRole.id],
                          });
                        });
                      }}
                    >
                      <KeyRoundIcon className="size-3.5" />
                      {pendingAction === "register" ? "Connecting…" : "Retry now"}
                    </Button>
                  </PermissionTooltip>
                  {serviceRole === undefined ? (
                    <p className="text-xs text-destructive">
                      Workspace permissions are still syncing. Pathway will retry automatically.
                    </p>
                  ) : null}
                  {actionError ? <p className="text-xs text-destructive">{actionError}</p> : null}
                </div>
              </CompanySectionCard>
            ) : null}
            <EnvironmentList
              connectedRows={companyEnvironmentsByConnection.connected}
              disconnectedRows={companyEnvironmentsByConnection.disconnected}
              ownManagedEndpointAvailable={ownManagedEndpointAvailable}
              ownCloudLinkPhase={cloudLinkStatus.phase}
              ownCloudLinkError={primaryCloudLinkState.error ?? cloudLinkStatus.error}
              deleteEnabled={manageGate.enabled && control !== null && pendingAction === null}
              deleteTooltip={manageGate.tooltip}
              deletingEnvironmentId={
                pendingAction?.startsWith("deactivate:")
                  ? (pendingAction.slice("deactivate:".length) as EnvironmentId)
                  : null
              }
              onInfo={(environmentId) => {
                setSelectedEnvironmentId(environmentId);
                setEnvironmentInfoOpen(true);
              }}
              onDelete={(environment) => {
                if (control === null) return;
                setSelectedEnvironmentId(environment.environmentId);
                void runAction(`deactivate:${environment.environmentId}`, () =>
                  control.deactivateEnvironment({
                    companyId,
                    environmentId: environment.environmentId,
                  }),
                ).then((deleted) => {
                  if (!deleted) {
                    setEnvironmentInfoOpen(true);
                    return;
                  }
                  setEnvironmentInfoOpen(false);
                  setSelectedEnvironmentId(null);
                });
              }}
              onDeleteAllDisconnected={() => {
                if (control === null) return;
                void runAction("deactivate-all-disconnected", async () => {
                  for (const environment of companyEnvironmentsByConnection.disconnected) {
                    await control.deactivateEnvironment({
                      companyId,
                      environmentId: environment.environmentId,
                    });
                  }
                });
              }}
            />
            {savedEnvironmentRows}
          </SettingsSection>
        )}
      />

      {selected ? (
        <Sheet
          open={environmentInfoOpen}
          onOpenChange={(open) => {
            setEnvironmentInfoOpen(open);
            if (!open) setSelectedEnvironmentId(null);
          }}
        >
          <SheetPopup className="max-w-xl">
            <SheetHeader>
              <div className="flex items-center gap-2 pr-8">
                <SheetTitle className="truncate">{selected.label}</SheetTitle>
                {selected.isOwnEnvironment ? <Badge variant="info">This device</Badge> : null}
                {registrationStateBadge(selected)}
                {selectedPathwayConnectStatus ? (
                  <PathwayConnectBadge status={selectedPathwayConnectStatus} />
                ) : null}
              </div>
              <SheetDescription>
                {selected.registration.descriptor.platform.os}/
                {selected.registration.descriptor.platform.arch} · server{" "}
                {selected.registration.descriptor.serverVersion}
              </SheetDescription>
            </SheetHeader>
            <SheetPanel className="space-y-5">
              <div className="grid gap-3 rounded-lg border p-3 text-xs sm:grid-cols-2">
                <div>
                  <p className="text-muted-foreground">Managed endpoint</p>
                  <p className="mt-1 font-medium text-foreground">
                    {(
                      selected.isOwnEnvironment && ownManagedEndpointAvailable !== null
                        ? ownManagedEndpointAvailable
                        : selected.registration.managedEndpointAvailable
                    )
                      ? "Available"
                      : "Unavailable"}
                  </p>
                </div>
                <div>
                  <p className="text-muted-foreground">Connection catalog</p>
                  <p className="mt-1 font-medium text-foreground">
                    {selected.isInCatalog
                      ? selected.catalogSource === "local"
                        ? "Present locally"
                        : "Discovered through company"
                      : "Not present"}
                  </p>
                </div>
                {selected.teamNames.length > 0 ? (
                  <div className="sm:col-span-2">
                    <p className="mb-1.5 text-muted-foreground">Teams</p>
                    <div className="flex flex-wrap gap-1.5">
                      {selected.teamNames.map((teamName) => (
                        <Badge key={teamName} variant="outline">
                          {teamName}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>

              {selected.isOwnEnvironment && cloudLinkStatus.phase === "exhausted" ? (
                <div
                  role="alert"
                  className="space-y-3 rounded-lg border border-warning/30 bg-warning/5 p-3"
                >
                  <div className="space-y-1">
                    <p className="text-sm font-medium text-foreground">
                      Pathway Connect could not reconnect
                    </p>
                    <p className="text-xs text-muted-foreground">
                      Automatic reconnection stopped after {cloudLinkStatus.maxAttempts} attempts.
                      Pathway will stay disconnected until you try again.
                    </p>
                    {cloudLinkStatus.error ? (
                      <p className="break-words text-xs text-destructive">
                        {cloudLinkStatus.error}
                      </p>
                    ) : null}
                  </div>
                  <Button size="sm" variant="outline" onClick={requestAlwaysOnCloudLinkRetry}>
                    <RefreshCwIcon className="size-3.5" />
                    Try reconnecting
                  </Button>
                </div>
              ) : null}

              {selected.isOwnEnvironment ? (
                <div className="rounded-lg border px-3 py-3 text-xs text-muted-foreground">
                  This is the environment currently hosting Pathway. Remote controls are only
                  available for other environments.
                </div>
              ) : selected.registration.state !== "active" ? (
                <div className="rounded-lg border px-3 py-3 text-xs text-muted-foreground">
                  This registration is revoked and cannot accept remote actions.
                </div>
              ) : (
                <>
                  <RemoteCommandForm
                    key={selected.environmentId}
                    environment={selected}
                    issuePending={pendingAction === "issue"}
                    actionBlocked={pendingAction !== null}
                    controlAvailable={control !== null}
                    dispatchGate={dispatchGate}
                    controlGate={controlGate}
                    readGate={readGate}
                    onIssue={async ({ kind, prompt, threadId, message }) => {
                      if (control === null) return false;
                      return runAction("issue", async () => {
                        const targetEnvironmentId = selected.environmentId;
                        if (kind === "startThread") {
                          await control.issueCommand({
                            companyId,
                            targetEnvironmentId,
                            cloudProjectId: null,
                            kind,
                            args: { kind, prompt: prompt.trim(), modelSelection: null },
                          });
                        } else if (kind === "sendMessage") {
                          await control.issueCommand({
                            companyId,
                            targetEnvironmentId,
                            cloudProjectId: null,
                            kind,
                            args: {
                              kind,
                              threadId: ThreadId.make(threadId.trim()),
                              message: message.trim(),
                            },
                          });
                        } else {
                          await control.issueCommand({
                            companyId,
                            targetEnvironmentId,
                            cloudProjectId: null,
                            kind,
                            args: { kind, threadId: ThreadId.make(threadId.trim()) },
                          });
                        }
                      });
                    }}
                  />

                  <div className="space-y-3 rounded-lg border p-3">
                    <div>
                      <p className="text-sm font-medium">Direct connection grant</p>
                      <p className="text-xs text-muted-foreground">
                        Mint a short-lived, single-use token for direct remote agent control.
                      </p>
                    </div>
                    {grant ? (
                      <GrantReveal
                        grant={grant}
                        onDismiss={() => setGrant(null)}
                        onError={setActionError}
                      />
                    ) : (
                      <PermissionTooltip tooltip={controlGate.tooltip}>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            !controlGate.enabled || control === null || pendingAction !== null
                          }
                          onClick={() => {
                            if (control === null) return;
                            void runAction("grant", async () => {
                              const issued = await control.issueConnectGrant({
                                companyId,
                                environmentId: selected.environmentId,
                                permission: "remoteAgents.control",
                              });
                              setGrant(issued);
                            });
                          }}
                        >
                          <KeyRoundIcon className="size-3.5" />
                          {pendingAction === "grant" ? "Minting…" : "Mint connect grant"}
                        </Button>
                      </PermissionTooltip>
                    )}
                  </div>
                </>
              )}

              {actionError ? (
                <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {actionError}
                </div>
              ) : null}

              <CommandHistory
                commands={recentCommands}
                loading={loadingCommands}
                error={readGate.enabled ? commandLoadError : readGate.tooltip}
                pendingAction={pendingAction}
                cancelEnabled={cancelEnabled}
                cancelTooltip={dispatchGate.tooltip}
                onRefresh={() => void refreshCommands()}
                onCancel={(command) => {
                  if (control === null) return;
                  void runAction(`cancel:${command.id}`, () =>
                    control.cancelCommand({ companyId, commandId: command.id }),
                  );
                }}
              />
            </SheetPanel>
          </SheetPopup>
        </Sheet>
      ) : null}
    </SettingsPageContainer>
  );
}
