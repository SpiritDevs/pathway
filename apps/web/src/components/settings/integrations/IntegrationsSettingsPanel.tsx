import {
  CloudProjectSyncEntity,
  IssueCycleEntity,
  IssueEntity,
} from "@spiritdevs/client-runtime/sync";
import type { IssueAutomationSettings } from "@spiritdevs/contracts";
import { Link } from "@tanstack/react-router";
import {
  ArrowDownIcon,
  ArrowLeftIcon,
  ArrowUpIcon,
  BotIcon,
  HashIcon,
  PlusIcon,
  RefreshCwIcon,
  SlackIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as Schema from "effect/Schema";

import {
  type CompanyAutomationJobSummary,
  type CompanyAutomationSettingsSummary,
  type CompanyIntegrationsClient,
  type CompanySlackIntegrationSummary,
  type CompanySlackWatchSummary,
} from "../../../cloud/companyIntegrations";
import { useCompanyIntegrationsClient } from "../../../cloud/useCompanyIntegrationsClient";
import { usePrimarySettings } from "../../../hooks/useSettings";
import { useSlackStatus, useSlackWatches } from "../../../state/issues";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Switch } from "../../ui/switch";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { IntakeSettingsPanel } from "../issues/IntakeSettingsPanel";
import { IssueAutomationSettingsSection } from "../issues/IssueAutomationSettingsSection";
import { SettingsPageContainer, SettingsSection } from "../settingsLayout";
import { searchableSetting } from "../settingsSearch";
import { permissionGate } from "../company/companySettings.logic";
import { environmentRegistrationsFromReplicaValues } from "../company/environmentSettings.logic";
import { CompanySectionCard, CompanySettingsEmptyState } from "../company/CompanySettingsShared";
import { CompanySettingsSheet } from "../company/CompanySettingsSheet";
import { useCompanySettings } from "../company/useCompanySettings";

type SheetState =
  | { readonly kind: "add" }
  | { readonly kind: "slack"; readonly integrationId: string; readonly view: SlackView }
  | { readonly kind: "automation" }
  | null;
type SlackView = "overview" | "channels" | "channel" | "controllers" | "health" | "danger";

const isProject = Schema.is(CloudProjectSyncEntity);
const isCycle = Schema.is(IssueCycleEntity);
const isIssue = Schema.is(IssueEntity);

function reportError(title: string, error: unknown): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "The integration change failed.",
    }),
  );
}

function formatAge(timestamp: number | null): string {
  if (timestamp === null) return "Never";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3_600)}h ago`;
}

function integrationBadge(integration: CompanySlackIntegrationSummary) {
  if (integration.state === "disconnected") return <Badge variant="secondary">Disconnected</Badge>;
  if (integration.blockedReason !== null) return <Badge variant="warning">Blocked</Badge>;
  if (integration.currentError !== null) return <Badge variant="error">Degraded</Badge>;
  if (integration.state === "active" && integration.controllerEnvironmentId === null) {
    return <Badge variant="warning">No controller</Badge>;
  }
  return (
    <Badge variant={integration.state === "active" ? "success" : "secondary"}>
      {integration.state === "active" ? "Active" : "Draft"}
    </Badge>
  );
}

function AddIntegrationSheet({
  client,
  companyId,
  open,
  onClose,
  onConnected,
  onChanged,
}: {
  readonly client: CompanyIntegrationsClient;
  readonly companyId: NonNullable<ReturnType<typeof useCompanySettings>["companyId"]>;
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onConnected: (integrationId: string) => void;
  readonly onChanged: () => Promise<void>;
}) {
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const connect = async () => {
    if (token.trim().length === 0 || busy) return;
    setBusy(true);
    try {
      const integration = await client.connect(companyId, token.trim());
      setToken("");
      await onChanged();
      onConnected(integration.id);
    } catch (error) {
      reportError("Could not connect Slack", error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <CompanySettingsSheet
      open={open}
      onOpenChange={(next) => !next && onClose()}
      title="Add Slack workspace"
      description="The token is validated by Slack, encrypted, and stored for this company. It is never written to an environment."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={busy || token.trim().length === 0} onClick={() => void connect()}>
            {busy ? "Connecting…" : "Connect workspace"}
          </Button>
        </>
      }
    >
      <label className="space-y-1.5">
        <span className="text-xs font-medium">Slack bot token</span>
        <Input
          autoFocus
          type="password"
          value={token}
          onChange={(event) => setToken(event.currentTarget.value)}
          placeholder="xoxb-…"
        />
        <span className="block text-[11px] text-muted-foreground">
          Pathway stores no plaintext token or reversible token hint.
        </span>
      </label>
    </CompanySettingsSheet>
  );
}

function ChannelEditor({
  watch,
  projects,
  cycles,
  disabled,
  onBack,
  onSave,
  onDelete,
}: {
  readonly watch: CompanySlackWatchSummary | null;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly cycles: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly disabled: boolean;
  readonly onBack: () => void;
  readonly onSave: (input: Record<string, unknown>) => Promise<void>;
  readonly onDelete: (() => Promise<void>) | null;
}) {
  const [channelId, setChannelId] = useState(watch?.channelId ?? "");
  const [channelName, setChannelName] = useState(watch?.channelName ?? "");
  const [projectId, setProjectId] = useState(watch?.cloudProjectId ?? "");
  const [cycleId, setCycleId] = useState(watch?.cycleId ?? "");
  const [everyMessage, setEveryMessage] = useState(watch?.trigger.everyMessage ?? false);
  const [botMention, setBotMention] = useState(watch?.trigger.botMention ?? false);
  const [autoInvestigate, setAutoInvestigate] = useState(watch?.autoInvestigate ?? false);
  const [autoAssign, setAutoAssign] = useState(watch?.autoAssign ?? false);
  const [reactionRoutes, setReactionRoutes] = useState(
    watch?.trigger.reactionRoutes.map((route) => ({ ...route })) ?? [],
  );
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (channelId.trim().length === 0 || channelName.trim().length === 0 || busy) return;
    setBusy(true);
    try {
      await onSave({
        ...(watch === null ? {} : { watchId: watch.id, expectedRevision: watch.revision }),
        channelId: channelId.trim(),
        channelName: channelName.trim().replace(/^#/, ""),
        cloudProjectId: projectId || null,
        cycleId: cycleId || null,
        autoInvestigate,
        autoAssign,
        trigger: {
          everyMessage,
          botMention,
          reactionRoutes: reactionRoutes
            .map((route) => ({ ...route, emoji: route.emoji.trim().replaceAll(":", "") }))
            .filter((route) => route.emoji.length > 0),
        },
      });
      onBack();
    } catch (error) {
      reportError("Could not save watched channel", error);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-5">
      <Button variant="ghost" size="xs" onClick={onBack}>
        <ArrowLeftIcon className="size-3.5" /> Back to channels
      </Button>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1">
          <span className="text-xs font-medium">Channel ID</span>
          <Input
            disabled={disabled || watch !== null}
            value={channelId}
            onChange={(event) => setChannelId(event.currentTarget.value)}
            placeholder="C0123456789"
          />
        </label>
        <label className="space-y-1">
          <span className="text-xs font-medium">Channel name</span>
          <Input
            disabled={disabled}
            value={channelName}
            onChange={(event) => setChannelName(event.currentTarget.value)}
            placeholder="product-feedback"
          />
        </label>
      </div>
      <label className="space-y-1">
        <span className="text-xs font-medium">Project</span>
        <select
          className="h-9 w-full rounded-lg border bg-background px-3 text-sm"
          disabled={disabled}
          value={projectId}
          onChange={(event) => setProjectId(event.currentTarget.value)}
        >
          <option value="">Company-wide triage</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium">Cycle</span>
        <select
          className="h-9 w-full rounded-lg border bg-background px-3 text-sm"
          disabled={disabled}
          value={cycleId}
          onChange={(event) => setCycleId(event.currentTarget.value)}
        >
          <option value="">No cycle</option>
          {cycles.map((cycle) => (
            <option key={cycle.id} value={cycle.id}>
              {cycle.name}
            </option>
          ))}
        </select>
      </label>
      <fieldset className="space-y-2">
        <div className="flex items-center justify-between">
          <legend className="text-xs font-medium">Ordered reaction routes</legend>
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={disabled}
            onClick={() =>
              setReactionRoutes((current) => [
                ...current,
                { emoji: "", cloudProjectId: null, autoInvestigate: null },
              ])
            }
          >
            <PlusIcon className="size-3" /> Add route
          </Button>
        </div>
        {reactionRoutes.length === 0 ? (
          <p className="rounded-lg border border-dashed p-3 text-center text-[11px] text-muted-foreground">
            No reaction routes. Enable every-message or bot-mention, or add one.
          </p>
        ) : (
          reactionRoutes.map((route, index) => (
            <div
              key={index}
              className="grid gap-2 rounded-lg border p-2 sm:grid-cols-[0.65fr_1fr_0.8fr_auto]"
            >
              <Input
                disabled={disabled}
                aria-label={`Reaction ${index + 1}`}
                value={route.emoji}
                onChange={(event) =>
                  setReactionRoutes((current) =>
                    current.map((item, candidate) =>
                      candidate === index ? { ...item, emoji: event.currentTarget.value } : item,
                    ),
                  )
                }
                placeholder="eyes"
              />
              <select
                aria-label={`Project override for reaction ${index + 1}`}
                className="h-9 rounded-lg border bg-background px-2 text-xs"
                disabled={disabled}
                value={route.cloudProjectId ?? ""}
                onChange={(event) =>
                  setReactionRoutes((current) =>
                    current.map((item, candidate) =>
                      candidate === index
                        ? { ...item, cloudProjectId: event.currentTarget.value || null }
                        : item,
                    ),
                  )
                }
              >
                <option value="">Use channel project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
              <select
                aria-label={`Investigation override for reaction ${index + 1}`}
                className="h-9 rounded-lg border bg-background px-2 text-xs"
                disabled={disabled}
                value={
                  route.autoInvestigate === null ? "inherit" : route.autoInvestigate ? "on" : "off"
                }
                onChange={(event) =>
                  setReactionRoutes((current) =>
                    current.map((item, candidate) =>
                      candidate === index
                        ? {
                            ...item,
                            autoInvestigate:
                              event.currentTarget.value === "inherit"
                                ? null
                                : event.currentTarget.value === "on",
                          }
                        : item,
                    ),
                  )
                }
              >
                <option value="inherit">Use channel setting</option>
                <option value="on">Investigate</option>
                <option value="off">Do not investigate</option>
              </select>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                disabled={disabled}
                aria-label={`Remove reaction ${index + 1}`}
                onClick={() =>
                  setReactionRoutes((current) =>
                    current.filter((_, candidate) => candidate !== index),
                  )
                }
              >
                ×
              </Button>
            </div>
          ))
        )}
      </fieldset>
      <div className="grid gap-2 sm:grid-cols-2">
        {[
          ["Every message", everyMessage, setEveryMessage],
          ["Bot mention", botMention, setBotMention],
          ["Auto-investigate", autoInvestigate, setAutoInvestigate],
          ["Auto-assign", autoAssign, setAutoAssign],
        ].map(([label, checked, set]) => (
          <label
            key={String(label)}
            className="flex items-center justify-between rounded-lg border p-3 text-xs"
          >
            <span>{String(label)}</span>
            <Switch
              disabled={disabled}
              checked={Boolean(checked)}
              onCheckedChange={(next) => (set as (value: boolean) => void)(next)}
            />
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <Button
          className="flex-1"
          disabled={
            disabled || busy || channelId.trim().length === 0 || channelName.trim().length === 0
          }
          onClick={() => void submit()}
        >
          {busy ? "Saving…" : watch === null ? "Watch channel" : "Save channel"}
        </Button>
        {onDelete === null ? null : (
          <Button
            variant="destructive"
            disabled={disabled || busy}
            onClick={() => void onDelete().then(onBack)}
          >
            Stop watching
          </Button>
        )}
      </div>
    </div>
  );
}

function SlackIntegrationSheet({
  client,
  companyId,
  integration,
  environments,
  projects,
  cycles,
  canManage,
  state,
  onState,
  onClose,
  onChanged,
}: {
  readonly client: CompanyIntegrationsClient;
  readonly companyId: NonNullable<ReturnType<typeof useCompanySettings>["companyId"]>;
  readonly integration: CompanySlackIntegrationSummary;
  readonly environments: ReadonlyArray<{ readonly environmentId: string; readonly label: string }>;
  readonly projects: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly cycles: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly canManage: boolean;
  readonly state: Extract<SheetState, { readonly kind: "slack" }>;
  readonly onState: (view: SlackView) => void;
  readonly onClose: () => void;
  readonly onChanged: () => Promise<void>;
}) {
  const [watches, setWatches] = useState<ReadonlyArray<CompanySlackWatchSummary>>([]);
  const [editing, setEditing] = useState<CompanySlackWatchSummary | null>(null);
  const [preferred, setPreferred] = useState(integration.preferredEnvironmentId ?? "");
  const [backups, setBackups] = useState<ReadonlyArray<string>>(integration.backupEnvironmentIds);
  const [token, setToken] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const refreshWatches = useCallback(
    async () => setWatches(await client.listWatches(companyId, integration.id)),
    [client, companyId, integration.id],
  );
  useEffect(() => {
    void refreshWatches().catch((error) => reportError("Could not load watched channels", error));
  }, [refreshWatches]);
  const mutate = async (title: string, action: () => Promise<unknown>) => {
    try {
      await action();
      await onChanged();
      await refreshWatches();
    } catch (error) {
      reportError(title, error);
    }
  };
  const nav: ReadonlyArray<[SlackView, string]> = [
    ["overview", "Overview"],
    ["channels", "Watched channels"],
    ["controllers", "Controller priority"],
    ["health", "Health"],
    ["danger", "Danger zone"],
  ];
  let body;
  if (state.view === "channel") {
    body = (
      <ChannelEditor
        watch={editing}
        projects={projects}
        cycles={cycles}
        disabled={!canManage}
        onBack={() => onState("channels")}
        onSave={async (input) =>
          mutate("Could not save channel", () =>
            editing === null
              ? client.createWatch({ companyId, integrationId: integration.id, ...input })
              : client.updateWatch({ companyId, integrationId: integration.id, ...input }),
          )
        }
        onDelete={
          editing === null
            ? null
            : () =>
                mutate("Could not stop watching channel", () =>
                  client.deleteWatch({
                    companyId,
                    integrationId: integration.id,
                    watchId: editing.id,
                    expectedRevision: editing.revision,
                  }),
                )
        }
      />
    );
  } else if (state.view === "channels") {
    body = (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Watched channels</p>
          <Button
            size="xs"
            disabled={!canManage}
            onClick={() => {
              setEditing(null);
              onState("channel");
            }}
          >
            <PlusIcon className="size-3.5" /> Add channel
          </Button>
        </div>
        {watches.length === 0 ? (
          <p className="rounded-lg border border-dashed p-5 text-center text-xs text-muted-foreground">
            No channels are watched.
          </p>
        ) : (
          watches.map((watch) => (
            <button
              type="button"
              key={watch.id}
              className="flex w-full items-center gap-3 rounded-lg border p-3 text-left hover:bg-muted/40"
              onClick={() => {
                setEditing(watch);
                onState("channel");
              }}
            >
              <HashIcon className="size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{watch.channelName}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {watch.trigger.everyMessage
                    ? "Every message"
                    : watch.trigger.botMention
                      ? "Mentions"
                      : `${watch.trigger.reactionRoutes.length} reaction routes`}
                </span>
              </span>
            </button>
          ))
        )}
      </div>
    );
  } else if (state.view === "controllers") {
    body = (
      <div className="space-y-4">
        <p className="text-xs text-muted-foreground">
          Only these environments may contend. Backups are tried in this order; the preferred
          environment safely fails back after two healthy heartbeats.
        </p>
        <label className="space-y-1">
          <span className="text-xs font-medium">Preferred environment</span>
          <select
            className="h-9 w-full rounded-lg border bg-background px-3 text-sm"
            disabled={!canManage}
            value={preferred}
            onChange={(event) => {
              const next = event.currentTarget.value;
              setPreferred(next);
              setBackups((current) => current.filter((id) => id !== next));
            }}
          >
            <option value="">Choose an environment</option>
            {environments.map((environment) => (
              <option key={environment.environmentId} value={environment.environmentId}>
                {environment.label}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="space-y-2">
          <legend className="text-xs font-medium">Ordered backups</legend>
          {environments
            .filter((environment) => environment.environmentId !== preferred)
            .map((environment) => {
              const backupIndex = backups.indexOf(environment.environmentId);
              return (
                <label
                  key={environment.environmentId}
                  className="flex items-center gap-2 rounded-lg border p-3 text-xs"
                >
                  <Checkbox
                    disabled={!canManage}
                    checked={backupIndex !== -1}
                    onCheckedChange={() =>
                      setBackups((current) =>
                        current.includes(environment.environmentId)
                          ? current.filter((id) => id !== environment.environmentId)
                          : [...current, environment.environmentId].slice(0, 10),
                      )
                    }
                  />
                  <span className="flex-1">{environment.label}</span>
                  {backupIndex !== -1 ? (
                    <>
                      <span className="text-muted-foreground">#{backupIndex + 1}</span>
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        disabled={!canManage || backupIndex === 0}
                        aria-label={`Move ${environment.label} up`}
                        onClick={(event) => {
                          event.preventDefault();
                          setBackups((current) => {
                            const next = [...current];
                            [next[backupIndex - 1], next[backupIndex]] = [
                              next[backupIndex]!,
                              next[backupIndex - 1]!,
                            ];
                            return next;
                          });
                        }}
                      >
                        <ArrowUpIcon className="size-3" />
                      </Button>
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        disabled={!canManage || backupIndex === backups.length - 1}
                        aria-label={`Move ${environment.label} down`}
                        onClick={(event) => {
                          event.preventDefault();
                          setBackups((current) => {
                            const next = [...current];
                            [next[backupIndex], next[backupIndex + 1]] = [
                              next[backupIndex + 1]!,
                              next[backupIndex]!,
                            ];
                            return next;
                          });
                        }}
                      >
                        <ArrowDownIcon className="size-3" />
                      </Button>
                    </>
                  ) : null}
                </label>
              );
            })}
        </fieldset>
        <Button
          disabled={!canManage || preferred.length === 0}
          onClick={() =>
            void mutate("Could not save controller priority", () =>
              client.setControllerPool({
                companyId,
                integrationId: integration.id,
                preferredEnvironmentId: preferred || null,
                backupEnvironmentIds: backups,
              }),
            )
          }
        >
          Save controller priority
        </Button>
      </div>
    );
  } else if (state.view === "health") {
    body = (
      <div className="space-y-4">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-3 rounded-lg border p-4 text-xs">
          <dt className="text-muted-foreground">Controller</dt>
          <dd>{integration.controllerEnvironmentId ?? "None"}</dd>
          <dt className="text-muted-foreground">Lease</dt>
          <dd>
            Generation {integration.leaseGeneration}
            {integration.leaseExpiresAt === null
              ? ""
              : ` · expires ${formatAge(integration.leaseExpiresAt)}`}
          </dd>
          <dt className="text-muted-foreground">Last successful poll</dt>
          <dd>{formatAge(integration.lastPollAt)}</dd>
          <dt className="text-muted-foreground">Current error</dt>
          <dd>{integration.currentError ?? integration.blockedReason ?? "None"}</dd>
        </dl>
        <div>
          <p className="mb-2 text-xs font-medium">Recent health</p>
          {integration.healthHistory.length === 0 ? (
            <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
              No poll history yet.
            </p>
          ) : (
            <div className="divide-y rounded-lg border">
              {[...integration.healthHistory].reverse().map((event) => (
                <div key={`${event.at}-${event.state}`} className="flex gap-3 p-3 text-xs">
                  <Badge variant={event.state === "healthy" ? "success" : "error"}>
                    {event.state}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">
                    {event.error ?? "Polling recovered"}
                  </span>
                  <span className="shrink-0 text-muted-foreground">{formatAge(event.at)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  } else if (state.view === "danger") {
    body = (
      <div className="space-y-5">
        <div className="rounded-lg border p-4">
          <p className="text-sm font-medium">Disconnect</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Deletes the encrypted credential and fences the lease. Watches, cursors and history are
            retained.
          </p>
          <Button
            className="mt-3"
            variant="outline"
            disabled={!canManage || integration.state === "disconnected"}
            onClick={() =>
              void mutate("Could not disconnect Slack", () =>
                client.disconnect({ companyId, integrationId: integration.id }),
              )
            }
          >
            Disconnect
          </Button>
        </div>
        <div className="rounded-lg border border-destructive/30 p-4">
          <p className="text-sm font-medium text-destructive">Remove integration</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Permanently deletes company Slack configuration and operational history. Existing issues
            remain readable.
          </p>
          <Input
            className="mt-3"
            disabled={!canManage}
            value={confirmName}
            onChange={(event) => setConfirmName(event.currentTarget.value)}
            placeholder={`Type ${integration.workspaceName}`}
          />
          <Button
            className="mt-3"
            variant="destructive"
            disabled={!canManage || confirmName !== integration.workspaceName}
            onClick={() =>
              void mutate("Could not remove integration", async () => {
                await client.remove({
                  companyId,
                  integrationId: integration.id,
                  confirmWorkspaceName: confirmName,
                });
                onClose();
              })
            }
          >
            Remove integration
          </Button>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="space-y-5">
        <div className="rounded-lg border p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{integration.workspaceName}</p>
              <p className="text-xs text-muted-foreground">
                {integration.workspaceDomain ?? integration.workspaceId}
              </p>
            </div>
            {integrationBadge(integration)}
          </div>
        </div>
        <label className="space-y-1">
          <span className="text-xs font-medium">Replace credential</span>
          <Input
            type="password"
            disabled={!canManage}
            value={token}
            onChange={(event) => setToken(event.currentTarget.value)}
            placeholder="xoxb-…"
          />
        </label>
        <Button
          variant="outline"
          disabled={!canManage || token.trim().length === 0}
          onClick={() =>
            void mutate("Could not replace credential", async () => {
              await client.connect(companyId, token.trim(), integration.id);
              setToken("");
            })
          }
        >
          Validate and replace
        </Button>
        {integration.state === "draft" ? (
          <div className="rounded-lg border p-4">
            <label className="flex items-start gap-2 text-xs">
              <Checkbox
                disabled={!canManage}
                checked={acknowledged}
                onCheckedChange={(next) => setAcknowledged(next === true)}
              />
              <span>
                I confirm older Pathway environments watching this workspace have been upgraded or
                disconnected, or the old token has been rotated.
              </span>
            </label>
            <Button
              className="mt-3"
              disabled={!canManage || !acknowledged || integration.preferredEnvironmentId === null}
              onClick={() =>
                void mutate("Could not activate integration", () =>
                  client.activate({
                    companyId,
                    integrationId: integration.id,
                    legacyWatchersAcknowledged: acknowledged,
                  }),
                )
              }
            >
              Activate integration
            </Button>
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <CompanySettingsSheet
      open
      onOpenChange={(next) => !next && onClose()}
      title={integration.workspaceName}
      description="Company-owned Slack intake and controller coordination."
      footer={
        <div className="flex w-full flex-wrap gap-1">
          {state.view === "channel"
            ? null
            : nav.map(([view, label]) => (
                <Button
                  key={view}
                  size="xs"
                  variant={state.view === view ? "secondary" : "ghost"}
                  onClick={() => onState(view)}
                >
                  {label}
                </Button>
              ))}
        </div>
      }
    >
      {!canManage ? (
        <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
          You have read-only access. The integrations.manage permission is required to change this
          configuration.
        </p>
      ) : null}
      {body}
    </CompanySettingsSheet>
  );
}

function AutomationSheet({
  client,
  companyId,
  summary,
  jobs,
  fallback,
  issueKeys,
  canManage,
  onClose,
  onChanged,
}: {
  readonly client: CompanyIntegrationsClient;
  readonly companyId: NonNullable<ReturnType<typeof useCompanySettings>["companyId"]>;
  readonly summary: CompanyAutomationSettingsSummary | null;
  readonly jobs: ReadonlyArray<CompanyAutomationJobSummary>;
  readonly fallback: IssueAutomationSettings;
  readonly issueKeys: ReadonlyMap<string, string>;
  readonly canManage: boolean;
  readonly onClose: () => void;
  readonly onChanged: () => Promise<void>;
}) {
  const settings = summary?.settings ?? fallback;
  const save = async (next: IssueAutomationSettings) => {
    if (!canManage) return;
    try {
      await client.saveAutomation({
        companyId,
        settings: next,
        expectedRevision: summary?.revision ?? null,
      });
      await onChanged();
    } catch (error) {
      reportError("Could not save issue automation", error);
    }
  };
  const act = async (title: string, action: () => Promise<unknown>) => {
    try {
      await action();
      await onChanged();
    } catch (error) {
      reportError(title, error);
    }
  };
  return (
    <CompanySettingsSheet
      open
      onOpenChange={(next) => !next && onClose()}
      title="Issue automation"
      description="Durable company jobs for routing, audits, review transitions and remediation."
      footer={
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      }
    >
      <label className="flex items-center justify-between gap-3 rounded-lg border p-4">
        <span className="min-w-0">
          <span className="block text-sm font-medium">Company automation</span>
          <span className="block text-xs text-muted-foreground">
            {summary?.enabled ? "Enabled" : "Paused"}
          </span>
        </span>
        <Switch
          className="shrink-0"
          disabled={!canManage || summary === null}
          checked={summary?.enabled ?? false}
          onCheckedChange={(enabled) =>
            void act("Could not change automation state", () =>
              client.setAutomationEnabled(companyId, enabled),
            )
          }
        />
      </label>
      {!canManage ? (
        <p className="rounded-lg bg-muted p-3 text-xs text-muted-foreground">
          You have read-only access. The integrations.manage permission is required to change
          automation.
        </p>
      ) : null}
      <div className={!canManage ? "pointer-events-none opacity-70" : undefined}>
        <IssueAutomationSettingsSection automation={settings} onSave={(next) => void save(next)} />
      </div>
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">Recent jobs</p>
          <Badge
            variant={
              jobs.some((job) => job.state === "failed" || job.state === "blocked")
                ? "warning"
                : "secondary"
            }
          >
            {jobs.length}
          </Badge>
        </div>
        {jobs.length === 0 ? (
          <p className="rounded-lg border border-dashed p-4 text-center text-xs text-muted-foreground">
            No automation jobs yet.
          </p>
        ) : (
          jobs.slice(0, 30).map((job) => (
            <div key={job.id} className="rounded-lg border p-3">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-xs font-medium">
                  {job.kind} · {issueKeys.get(job.issueId) ?? job.issueId}
                </span>
                <Badge
                  variant={
                    job.state === "failed"
                      ? "error"
                      : job.state === "blocked"
                        ? "warning"
                        : job.state === "succeeded"
                          ? "success"
                          : "secondary"
                  }
                >
                  {job.state}
                </Badge>
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                Target: {job.targetEnvironmentId ?? "unresolved"} · Attempt {job.attempts}
                {job.diagnostic === null ? "" : ` · ${job.diagnostic}`}
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {issueKeys.has(job.issueId) ? (
                  <Button
                    render={
                      <Link
                        to="/issues"
                        search={{ issue: issueKeys.get(job.issueId) }}
                        target="_blank"
                      />
                    }
                    size="xs"
                    variant="ghost"
                  >
                    Open issue
                  </Button>
                ) : null}
                {canManage && (job.state === "failed" || job.state === "blocked") ? (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      void act("Could not retry job", () => client.retryJob(companyId, job.id))
                    }
                  >
                    Retry
                  </Button>
                ) : null}
                {canManage &&
                (job.state === "pending" ||
                  job.state === "blocked" ||
                  job.state === "claimed" ||
                  job.state === "running") ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      void act("Could not cancel job", () => client.cancelJob(companyId, job.id))
                    }
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            </div>
          ))
        )}
      </div>
    </CompanySettingsSheet>
  );
}

function PersonalIntegrationsPanel() {
  const status = useSlackStatus();
  const watches = useSlackWatches();
  const [open, setOpen] = useState<"slack" | "automation" | null>(null);
  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("issue-intake")}>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Personal integrations</p>
            <p className="text-xs text-muted-foreground">
              Configuration and execution remain on this environment.
            </p>
          </div>
          {!status.configured ? (
            <Button size="sm" onClick={() => setOpen("slack")}>
              <PlusIcon className="size-4" /> Add integration
            </Button>
          ) : null}
        </div>
        <CompanySectionCard>
          <button
            type="button"
            className="flex w-full items-center gap-3 p-4 text-left hover:bg-muted/40"
            onClick={() => setOpen("slack")}
          >
            <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
              <SlackIcon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="text-sm font-medium">Slack</span>
                <Badge variant={status.configured ? "success" : "secondary"}>
                  {status.configured ? "Connected" : "Disconnected"}
                </Badge>
              </span>
              <span className="block text-xs text-muted-foreground">
                {watches.length} watched {watches.length === 1 ? "channel" : "channels"} · Local
                environment
              </span>
            </span>
          </button>
        </CompanySectionCard>
      </SettingsSection>
      <SettingsSection {...searchableSetting("issue-intake-automation")}>
        <CompanySectionCard>
          <button
            type="button"
            className="flex w-full items-center gap-3 p-4 text-left hover:bg-muted/40"
            onClick={() => setOpen("automation")}
          >
            <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
              <BotIcon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="text-sm font-medium">Issue automation</span>
              <span className="block text-xs text-muted-foreground">
                Local routing, audits, review transitions and remediation
              </span>
            </span>
          </button>
        </CompanySectionCard>
      </SettingsSection>
      <CompanySettingsSheet
        open={open === "slack"}
        onOpenChange={(next) => !next && setOpen(null)}
        title="Slack"
        description="Connect one workspace and configure its local watched channels."
        footer={
          <Button variant="outline" onClick={() => setOpen(null)}>
            Close
          </Button>
        }
      >
        <IntakeSettingsPanel includeAutomation={false} />
      </CompanySettingsSheet>
      <CompanySettingsSheet
        open={open === "automation"}
        onOpenChange={(next) => !next && setOpen(null)}
        title="Issue automation"
        description="Automation on a personal workspace is owned by this environment."
        footer={
          <Button variant="outline" onClick={() => setOpen(null)}>
            Close
          </Button>
        }
      >
        <IssueAutomationSettingsSection />
      </CompanySettingsSheet>
    </SettingsPageContainer>
  );
}

export function IntegrationsSettingsPanel() {
  const company = useCompanySettings();
  const localSettings = usePrimarySettings();
  const client = useCompanyIntegrationsClient();
  const workspaceKind =
    company.activeCompany?.workspaceKind ?? company.directory.company?.workspaceKind ?? "personal";
  const [integrations, setIntegrations] = useState<ReadonlyArray<CompanySlackIntegrationSummary>>(
    [],
  );
  const [automation, setAutomation] = useState<CompanyAutomationSettingsSummary | null>(null);
  const [jobs, setJobs] = useState<ReadonlyArray<CompanyAutomationJobSummary>>([]);
  const [loadedCompanyId, setLoadedCompanyId] = useState(company.companyId);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [automationLoadError, setAutomationLoadError] = useState<string | null>(null);
  const refreshVersionRef = useRef(0);
  const companyIdRef = useRef(company.companyId);
  companyIdRef.current = company.companyId;
  const values = company.replica?.view.values() ?? [];
  const environments = useMemo(
    () =>
      environmentRegistrationsFromReplicaValues(values)
        .filter((row) => row.state === "active")
        .map((row) => ({
          environmentId: row.environmentId,
          label:
            typeof row.descriptor === "object" &&
            row.descriptor !== null &&
            "name" in row.descriptor &&
            typeof row.descriptor.name === "string"
              ? row.descriptor.name
              : row.environmentId,
        })),
    [values],
  );
  const projects = useMemo(
    () =>
      [...values]
        .filter(isProject)
        .filter((row) => row.archivedAt === null)
        .map((row) => ({ id: row.id, name: row.name })),
    [values],
  );
  const cycles = useMemo(
    () =>
      [...values]
        .filter(isCycle)
        .filter((row) => row.completedAt === null)
        .map((row) => ({ id: row.id, name: row.name })),
    [values],
  );
  const issueKeys = useMemo(
    () => new Map([...values].filter(isIssue).map((issue) => [issue.id, issue.key])),
    [values],
  );
  const readGate = permissionGate(company.permissions, "integrations.read");
  const manageGate = permissionGate(company.permissions, "integrations.manage");
  const refresh = useCallback(async () => {
    if (client === null || company.companyId === null || !readGate.enabled) return;
    const companyId = company.companyId;
    const refreshVersion = ++refreshVersionRef.current;
    setLoading(true);
    setLoadError(null);
    setAutomationLoadError(null);
    const isCurrent = () =>
      refreshVersion === refreshVersionRef.current && companyIdRef.current === companyId;
    const loadIntegrations = client
      .list(companyId)
      .then((nextIntegrations) => {
        if (!isCurrent()) return;
        setIntegrations(nextIntegrations);
        setLoadedCompanyId(companyId);
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        setLoadError(error instanceof Error ? error.message : "Could not load integrations.");
        reportError("Could not load integrations", error);
      })
      .finally(() => {
        if (isCurrent()) setLoading(false);
      });
    const loadAutomation = Promise.all([
      client.getAutomation(companyId),
      client.listJobs(companyId),
    ])
      .then(([nextAutomation, nextJobs]) => {
        if (!isCurrent()) return;
        setAutomation(nextAutomation);
        setJobs(nextJobs);
      })
      .catch((error: unknown) => {
        if (!isCurrent()) return;
        setAutomationLoadError(
          error instanceof Error ? error.message : "Could not load issue automation.",
        );
        reportError("Could not load issue automation", error);
      });
    await Promise.all([loadIntegrations, loadAutomation]);
  }, [client, company.companyId, readGate.enabled]);
  useEffect(() => {
    refreshVersionRef.current += 1;
    setSheet(null);
    setLoading(true);
    setLoadError(null);
    setAutomationLoadError(null);
    if (workspaceKind !== "organization" || company.companyId === null) {
      setLoading(false);
      return;
    }
    if (client === null || !readGate.enabled) {
      setLoading(false);
      setLoadError(
        client === null
          ? "Company integrations are unavailable while cloud sync is disconnected."
          : (readGate.tooltip ?? "You do not have permission to view company integrations."),
      );
      return;
    }
    void refresh();
  }, [client, company.companyId, readGate.enabled, readGate.tooltip, refresh, workspaceKind]);
  if (workspaceKind !== "organization") return <PersonalIntegrationsPanel />;
  if (!readGate.enabled)
    return (
      <SettingsPageContainer>
        <CompanySettingsEmptyState
          title="Integrations are restricted"
          description={
            readGate.tooltip ?? "You do not have permission to view company integrations."
          }
        />
      </SettingsPageContainer>
    );
  const dataMatchesCompany = loadedCompanyId === company.companyId;
  const visibleIntegrations = dataMatchesCompany ? integrations : [];
  const visibleAutomation = dataMatchesCompany ? automation : null;
  const visibleJobs = dataMatchesCompany ? jobs : [];
  const selected =
    sheet?.kind === "slack"
      ? (visibleIntegrations.find((item) => item.id === sheet.integrationId) ?? null)
      : null;
  const attention =
    visibleIntegrations.filter(
      (item) =>
        item.blockedReason !== null ||
        item.currentError !== null ||
        (item.state === "active" && item.controllerEnvironmentId === null),
    ).length +
    visibleJobs.filter((job) => job.state === "blocked" || job.state === "failed").length;
  return (
    <SettingsPageContainer>
      <SettingsSection {...searchableSetting("issue-intake")}>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Company integrations</p>
            <p className="text-xs text-muted-foreground">
              Shared configuration, central deduplication and one controller per Slack workspace.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {attention > 0 ? <Badge variant="warning">{attention} need attention</Badge> : null}
            <Button
              size="sm"
              disabled={!manageGate.enabled || client === null}
              onClick={() => setSheet({ kind: "add" })}
            >
              <PlusIcon className="size-4" /> Add integration
            </Button>
          </div>
        </div>
        <CompanySectionCard>
          {loading ? (
            <div className="p-8 text-center text-xs text-muted-foreground">
              Loading integrations…
            </div>
          ) : loadError !== null ? (
            <div className="flex flex-col items-center gap-3 p-8 text-center">
              <p className="text-xs text-muted-foreground">{loadError}</p>
              <Button size="sm" variant="outline" onClick={() => void refresh()}>
                <RefreshCwIcon className="size-3.5" /> Retry
              </Button>
            </div>
          ) : visibleIntegrations.length === 0 ? (
            <div className="p-8 text-center text-xs text-muted-foreground">
              No Slack workspaces connected.
            </div>
          ) : (
            visibleIntegrations.map((integration) => (
              <button
                key={integration.id}
                type="button"
                className="flex w-full items-center gap-3 border-b p-4 text-left last:border-b-0 hover:bg-muted/40"
                onClick={() =>
                  setSheet({ kind: "slack", integrationId: integration.id, view: "overview" })
                }
              >
                <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
                  <SlackIcon className="size-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">
                      {integration.workspaceName}
                    </span>
                    {integrationBadge(integration)}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {integration.watchCount} watched channels ·{" "}
                    {integration.controllerEnvironmentId ?? "No controller"} · Polled{" "}
                    {formatAge(integration.lastPollAt)}
                  </span>
                  {integration.currentError !== null || integration.blockedReason !== null ? (
                    <span className="block truncate text-[11px] text-destructive">
                      {integration.currentError ?? integration.blockedReason}
                    </span>
                  ) : null}
                </span>
              </button>
            ))
          )}
        </CompanySectionCard>
      </SettingsSection>
      <SettingsSection {...searchableSetting("issue-intake-automation")}>
        <CompanySectionCard>
          <button
            type="button"
            className="flex w-full items-center gap-3 p-4 text-left hover:bg-muted/40"
            onClick={() => setSheet({ kind: "automation" })}
          >
            <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
              <BotIcon className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="text-sm font-medium">Issue automation</span>
                <Badge
                  variant={
                    automationLoadError !== null
                      ? "error"
                      : visibleAutomation?.enabled
                        ? "success"
                        : "secondary"
                  }
                >
                  {automationLoadError !== null
                    ? "Unavailable"
                    : visibleAutomation?.enabled
                      ? "Enabled"
                      : "Paused"}
                </Badge>
              </span>
              <span className="block text-xs text-muted-foreground">
                {automationLoadError ?? (
                  <>
                    {
                      visibleJobs.filter(
                        (job) =>
                          job.state === "pending" ||
                          job.state === "running" ||
                          job.state === "claimed",
                      ).length
                    }{" "}
                    active ·{" "}
                    {
                      visibleJobs.filter((job) => job.state === "blocked" || job.state === "failed")
                        .length
                    }{" "}
                    need attention
                  </>
                )}
              </span>
            </span>
            <RefreshCwIcon className="size-4 text-muted-foreground" />
          </button>
        </CompanySectionCard>
      </SettingsSection>
      {client !== null && company.companyId !== null ? (
        <>
          <AddIntegrationSheet
            client={client}
            companyId={company.companyId}
            open={sheet?.kind === "add"}
            onClose={() => setSheet(null)}
            onConnected={(integrationId) =>
              setSheet({ kind: "slack", integrationId, view: "overview" })
            }
            onChanged={refresh}
          />
          {selected !== null && sheet?.kind === "slack" ? (
            <SlackIntegrationSheet
              client={client}
              companyId={company.companyId}
              integration={selected}
              environments={environments}
              projects={projects}
              cycles={cycles}
              canManage={manageGate.enabled}
              state={sheet}
              onState={(view) => setSheet({ ...sheet, view })}
              onClose={() => setSheet(null)}
              onChanged={refresh}
            />
          ) : null}
          {sheet?.kind === "automation" ? (
            <AutomationSheet
              client={client}
              companyId={company.companyId}
              summary={visibleAutomation}
              jobs={visibleJobs}
              fallback={localSettings.issueAutomation}
              issueKeys={issueKeys}
              canManage={manageGate.enabled}
              onClose={() => setSheet(null)}
              onChanged={refresh}
            />
          ) : null}
        </>
      ) : null}
    </SettingsPageContainer>
  );
}
