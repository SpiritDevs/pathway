import {
  CheckCircle2Icon,
  CircleAlertIcon,
  CircleDashedIcon,
  HashIcon,
  LockIcon,
  PlusIcon,
  RefreshCwIcon,
  RotateCcwIcon,
  SlackIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "~/components/ui/alert";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Spinner } from "~/components/ui/spinner";
import { cn, randomUUID } from "~/lib/utils";

import { CompanySettingsSheet } from "../company/CompanySettingsSheet";
import {
  createDefaultSlackRoutingRule,
  createEmptySlackWorkspaceDraft,
  defaultSlackActivationStages,
  resolveSlackWizardNavigation,
  slackRoutingRulesError,
  slackRuleError,
  slackWizardStepError,
  type SlackActivationStage,
  type SlackActivationStageState,
  type SlackChannelOption,
  type SlackOwnerCatalog,
  type SlackOwnerOption,
  type SlackReadinessState,
  type SlackRoutingRule,
  type SlackWorkspaceIdentity,
  type SlackWorkspaceWizardDraft,
  type SlackWorkspaceWizardStep,
  type SlackWizardReadiness,
  type SlackWizardValidationContext,
} from "./slackWorkspaceWizard.logic";
import { SlackRouteRuleEditor, SlackRuleAutomationEditor } from "./SlackRouteRuleEditor";
import { SlackWorkspaceWizardSteps } from "./SlackWorkspaceWizardSteps";

export interface SlackWorkspaceConnectInput {
  readonly ownerId: string;
  readonly token: string;
}

export interface SlackWorkspaceConnectResult {
  readonly integrationId: string;
  readonly workspace: SlackWorkspaceIdentity;
}

export interface SlackWorkspaceActivationResult {
  readonly outcome: "healthy" | "active-warning";
  readonly message?: string | null;
}

export type SlackActivationProgressReporter = (
  stageId: SlackActivationStage["id"],
  state: SlackActivationStageState,
  detail?: string | null,
) => void;

export interface SlackWorkspaceWizardSheetProps {
  readonly open: boolean;
  readonly mode?: "new" | "draft" | "active";
  readonly owners: readonly SlackOwnerOption[];
  readonly initialDraft?: SlackWorkspaceWizardDraft | null;
  readonly getOwnerCatalog: (ownerId: string) => SlackOwnerCatalog;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConnect: (input: SlackWorkspaceConnectInput) => Promise<SlackWorkspaceConnectResult>;
  readonly onListChannels: (input: {
    readonly ownerId: string;
    readonly integrationId: string;
  }) => Promise<readonly SlackChannelOption[]>;
  readonly onSaveDraft: (
    draft: SlackWorkspaceWizardDraft,
  ) => Promise<SlackWorkspaceWizardDraft | void>;
  readonly onCheckReadiness: (
    draft: SlackWorkspaceWizardDraft,
  ) => Promise<readonly SlackWizardReadiness[]>;
  readonly onActivate: (
    draft: SlackWorkspaceWizardDraft,
    reportProgress: SlackActivationProgressReporter,
  ) => Promise<SlackWorkspaceActivationResult>;
  readonly onDeleteDraft?: (draft: SlackWorkspaceWizardDraft) => Promise<void>;
  readonly onComplete?: (
    draft: SlackWorkspaceWizardDraft,
    result: SlackWorkspaceActivationResult,
  ) => void;
}

type AsyncState = "idle" | "loading" | "ready" | "error";

function createViewId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function updateRule(
  rules: readonly SlackRoutingRule[],
  ruleId: string,
  update: SlackRoutingRule,
): readonly SlackRoutingRule[] {
  return rules.map((rule) => (rule.id === ruleId ? update : rule));
}

function moveRule(
  rules: readonly SlackRoutingRule[],
  index: number,
  direction: "up" | "down",
): readonly SlackRoutingRule[] {
  const target = direction === "up" ? index - 1 : index + 1;
  if (target < 0 || target >= rules.length) return rules;
  const next = [...rules];
  [next[index], next[target]] = [next[target]!, next[index]!];
  return next;
}

function readinessIcon(state: SlackReadinessState) {
  if (state === "ready") return <CheckCircle2Icon className="size-4 text-success" />;
  return (
    <CircleAlertIcon
      className={cn("size-4", state === "blocked" ? "text-destructive" : "text-warning")}
    />
  );
}

function activationIcon(state: SlackActivationStageState) {
  switch (state) {
    case "running":
      return <Spinner className="size-4 text-primary" />;
    case "complete":
      return <CheckCircle2Icon className="size-4 text-success" />;
    case "warning":
      return <CircleAlertIcon className="size-4 text-warning" />;
    case "error":
      return <CircleAlertIcon className="size-4 text-destructive" />;
    case "pending":
      return <CircleDashedIcon className="size-4 text-muted-foreground" />;
  }
}

export function SlackWorkspaceWizardSheet({
  open,
  mode = "new",
  owners,
  initialDraft,
  getOwnerCatalog,
  onOpenChange,
  onConnect,
  onListChannels,
  onSaveDraft,
  onCheckReadiness,
  onActivate,
  onDeleteDraft,
  onComplete,
}: SlackWorkspaceWizardSheetProps) {
  const [step, setStep] = useState<SlackWorkspaceWizardStep>(0);
  const [draft, setDraft] = useState<SlackWorkspaceWizardDraft>(
    () => initialDraft ?? createEmptySlackWorkspaceDraft(),
  );
  const [token, setToken] = useState("");
  const [channels, setChannels] = useState<readonly SlackChannelOption[]>([]);
  const [channelState, setChannelState] = useState<AsyncState>("idle");
  const [readiness, setReadiness] = useState<readonly SlackWizardReadiness[]>([]);
  const [readinessState, setReadinessState] = useState<AsyncState>("idle");
  const [activationStages, setActivationStages] = useState<readonly SlackActivationStage[]>(
    defaultSlackActivationStages,
  );
  const [activationState, setActivationState] = useState<AsyncState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);
  const [expandedRuleId, setExpandedRuleId] = useState<string | null>(null);
  const requestVersionRef = useRef(0);
  const wasOpenRef = useRef(false);

  const selectedOwner = owners.find((owner) => owner.id === draft.ownerId) ?? null;
  const catalog = draft.ownerId
    ? getOwnerCatalog(draft.ownerId)
    : { teams: [], statuses: [], projects: [], cycles: [] };

  const validationContext = useMemo<SlackWizardValidationContext>(
    () => ({
      ownerIds: new Set(owners.filter((owner) => owner.canManage).map((owner) => owner.id)),
      channelIds: new Set(channels.map((channel) => channel.id)),
      teamIds: new Set(catalog.teams.map((team) => team.id)),
      projectIds: new Set(catalog.projects.map((project) => project.id)),
      statusIds: new Set(catalog.statuses.map((status) => status.id)),
      cycleIds: new Set((catalog.cycles ?? []).map((cycle) => cycle.id)),
      readiness,
    }),
    [
      catalog.cycles,
      catalog.projects,
      catalog.statuses,
      catalog.teams,
      channels,
      owners,
      readiness,
    ],
  );

  useEffect(() => {
    if (!open) {
      requestVersionRef.current += 1;
      setToken("");
      wasOpenRef.current = false;
      return;
    }
    if (wasOpenRef.current) return;
    wasOpenRef.current = true;
    const nextDraft = initialDraft ?? createEmptySlackWorkspaceDraft();
    setStep(0);
    setDraft(nextDraft);
    setToken("");
    setChannels([]);
    setChannelState("idle");
    setReadiness([]);
    setReadinessState("idle");
    setActivationStages(defaultSlackActivationStages());
    setActivationState("idle");
    setError(null);
    setSuccessMessage(null);
    setExpandedRuleId(nextDraft.rules[0]?.id ?? null);
  }, [initialDraft, open]);

  const loadChannels = useCallback(
    async (ownerId: string, integrationId: string) => {
      const requestVersion = ++requestVersionRef.current;
      setChannelState("loading");
      setError(null);
      try {
        const nextChannels = await onListChannels({ ownerId, integrationId });
        if (requestVersion !== requestVersionRef.current) return;
        setChannels(nextChannels);
        setChannelState("ready");
      } catch (cause) {
        if (requestVersion !== requestVersionRef.current) return;
        setChannels([]);
        setChannelState("error");
        setError(cause instanceof Error ? cause.message : "Could not load Slack channels.");
      }
    },
    [onListChannels],
  );

  useEffect(() => {
    if (!open || !draft.ownerId || !draft.integrationId || channelState !== "idle") return;
    void loadChannels(draft.ownerId, draft.integrationId);
  }, [channelState, draft.integrationId, draft.ownerId, loadChannels, open]);

  const close = () => {
    requestVersionRef.current += 1;
    setToken("");
    setError(null);
    onOpenChange(false);
  };

  const connectWorkspace = async () => {
    if (!draft.ownerId || !token.trim()) return;
    setChannelState("loading");
    setError(null);
    const requestVersion = ++requestVersionRef.current;
    try {
      const result = await onConnect({ ownerId: draft.ownerId, token: token.trim() });
      if (requestVersion !== requestVersionRef.current) return;
      const nextDraft = {
        ...draft,
        integrationId: result.integrationId,
        integrationRevision: null,
        workspace: result.workspace,
        channelId: null,
        channelName: null,
        watchId: null,
        watchRevision: null,
      };
      setDraft(nextDraft);
      setChannels([]);
      setChannelState("idle");
      await loadChannels(draft.ownerId, result.integrationId);
    } catch (cause) {
      if (requestVersion === requestVersionRef.current) {
        setChannelState("error");
        setError(cause instanceof Error ? cause.message : "Slack could not validate that token.");
      }
    } finally {
      setToken("");
    }
  };

  const checkReadiness = async (nextDraft = draft) => {
    const requestVersion = ++requestVersionRef.current;
    setReadinessState("loading");
    setError(null);
    try {
      const checks = await onCheckReadiness(nextDraft);
      if (requestVersion !== requestVersionRef.current) return;
      setReadiness(checks);
      setReadinessState("ready");
    } catch (cause) {
      if (requestVersion !== requestVersionRef.current) return;
      setReadiness([]);
      setReadinessState("error");
      setError(cause instanceof Error ? cause.message : "Could not check activation readiness.");
    }
  };

  const saveAndContinue = async () => {
    setError(null);
    const stepError = slackWizardStepError(step, draft, validationContext);
    if (stepError) {
      setError(stepError);
      return;
    }
    if (step === 2) return;
    setActivationState("loading");
    try {
      const saved = await onSaveDraft(draft);
      const nextDraft = saved ?? draft;
      setDraft(nextDraft);
      const nextStep = (step + 1) as SlackWorkspaceWizardStep;
      setStep(nextStep);
      if (nextStep === 2) await checkReadiness(nextDraft);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save this Slack setup draft.");
    } finally {
      setActivationState("idle");
    }
  };

  const selectStep = async (requestedStep: SlackWorkspaceWizardStep) => {
    const navigation = resolveSlackWizardNavigation(step, requestedStep, draft, validationContext);
    if (navigation.error) setError(navigation.error);
    setStep(navigation.step);
    if (navigation.step === 2 && readinessState === "idle") await checkReadiness();
  };

  const activateWorkspace = async () => {
    const stepError = slackWizardStepError(2, draft, validationContext);
    if (stepError) {
      setError(stepError);
      return;
    }
    setError(null);
    setSuccessMessage(null);
    setActivationState("loading");
    setActivationStages(defaultSlackActivationStages());
    try {
      const result = await onActivate(draft, (stageId, state, detail) => {
        setActivationStages((current) =>
          current.map((stage) =>
            stage.id === stageId
              ? { ...stage, state, ...(detail === undefined ? {} : { detail }) }
              : stage,
          ),
        );
      });
      setActivationState("ready");
      setSuccessMessage(
        result.message ??
          (result.outcome === "healthy"
            ? "Slack intake is active and healthy."
            : "Slack intake is active. The first health check is still pending."),
      );
      setToken("");
      onComplete?.(draft, result);
    } catch (cause) {
      setActivationState("error");
      setToken("");
      setError(cause instanceof Error ? cause.message : "Could not activate Slack intake.");
    }
  };

  const deleteDraft = async () => {
    if (!onDeleteDraft) return;
    setError(null);
    setActivationState("loading");
    try {
      await onDeleteDraft(draft);
      close();
    } catch (cause) {
      setActivationState("error");
      setError(cause instanceof Error ? cause.message : "Could not delete this setup draft.");
    }
  };

  const stepZeroError = slackWizardStepError(0, draft, validationContext);
  const stepOneError = slackWizardStepError(1, draft, validationContext);
  const completedThrough = stepZeroError
    ? -1
    : stepOneError
      ? 0
      : activationState === "ready"
        ? 2
        : 1;
  const summaries = [
    draft.workspace?.name ?? null,
    draft.rules.length > 0
      ? `${draft.rules.length} ${draft.rules.length === 1 ? "route" : "routes"}`
      : null,
    activationState === "ready" ? "Active" : null,
  ];

  const footer = (
    <div className="flex w-full items-center gap-2">
      {onDeleteDraft && draft.integrationId ? (
        <Button
          aria-label="Delete Slack setup draft"
          disabled={activationState === "loading"}
          onClick={() => void deleteDraft()}
          size="icon-sm"
          type="button"
          variant="ghost"
        >
          <Trash2Icon />
        </Button>
      ) : null}
      <span className="flex-1" />
      {step > 0 ? (
        <Button
          disabled={activationState === "loading"}
          onClick={() => setStep((step - 1) as SlackWorkspaceWizardStep)}
          type="button"
          variant="outline"
        >
          Back
        </Button>
      ) : (
        <Button
          disabled={activationState === "loading"}
          onClick={close}
          type="button"
          variant="outline"
        >
          Cancel
        </Button>
      )}
      {step < 2 ? (
        <Button
          disabled={activationState === "loading"}
          onClick={() => void saveAndContinue()}
          type="button"
        >
          {activationState === "loading" ? <Spinner className="size-4" /> : null}
          Continue
        </Button>
      ) : activationState === "ready" ? (
        <Button onClick={close} type="button">
          Done
        </Button>
      ) : (
        <Button
          disabled={
            activationState === "loading" ||
            readinessState !== "ready" ||
            readiness.some((item) => item.state === "blocked")
          }
          onClick={() => void activateWorkspace()}
          type="button"
        >
          {activationState === "loading" ? <Spinner className="size-4" /> : null}
          Activate Slack intake
        </Button>
      )}
    </div>
  );

  return (
    <CompanySettingsSheet
      description="Connect one workspace, define first-match routing, then activate automation."
      footer={footer}
      onOpenChange={(nextOpen) => (nextOpen ? onOpenChange(true) : close())}
      open={open}
      title={
        mode === "active"
          ? "Edit Slack workspace"
          : mode === "draft"
            ? "Finish Slack workspace setup"
            : "Add Slack workspace"
      }
    >
      <SlackWorkspaceWizardSteps
        completedThrough={completedThrough}
        currentStep={step}
        onStepSelect={(nextStep) => void selectStep(nextStep)}
        summaries={summaries}
      />

      {error ? (
        <Alert controlAlignment="first-line" variant="error">
          <CircleAlertIcon />
          <AlertTitle>Slack setup needs attention</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {successMessage ? (
        <Alert
          controlAlignment="first-line"
          variant={successMessage.includes("pending") ? "warning" : "success"}
        >
          <CheckCircle2Icon />
          <AlertTitle>Slack intake activated</AlertTitle>
          <AlertDescription>{successMessage}</AlertDescription>
        </Alert>
      ) : null}

      {step === 0 ? (
        <ConnectSlackStep
          channelState={channelState}
          channels={channels}
          draft={draft}
          onConnect={() => void connectWorkspace()}
          onDraftChange={setDraft}
          onRetryChannels={() => {
            if (draft.ownerId && draft.integrationId)
              void loadChannels(draft.ownerId, draft.integrationId);
          }}
          onTokenChange={setToken}
          ownerLocked={draft.integrationId !== null}
          owners={owners}
          selectedOwner={selectedOwner}
          token={token}
        />
      ) : step === 1 ? (
        <RouteIssuesStep
          catalog={catalog}
          draft={draft}
          expandedRuleId={expandedRuleId}
          onDraftChange={setDraft}
          onExpandedRuleChange={setExpandedRuleId}
          validationContext={validationContext}
        />
      ) : (
        <AutomateAndActivateStep
          activationStages={activationStages}
          activationState={activationState}
          catalog={catalog}
          draft={draft}
          onDraftChange={(nextDraft) => {
            setDraft(nextDraft);
            setReadiness([]);
            setReadinessState("idle");
          }}
          onRetryReadiness={() => void checkReadiness()}
          readiness={readiness}
          readinessState={readinessState}
        />
      )}
    </CompanySettingsSheet>
  );
}

function ConnectSlackStep({
  draft,
  owners,
  selectedOwner,
  token,
  channels,
  channelState,
  onDraftChange,
  onTokenChange,
  onConnect,
  onRetryChannels,
  ownerLocked,
}: {
  readonly draft: SlackWorkspaceWizardDraft;
  readonly owners: readonly SlackOwnerOption[];
  readonly selectedOwner: SlackOwnerOption | null;
  readonly token: string;
  readonly channels: readonly SlackChannelOption[];
  readonly channelState: AsyncState;
  readonly onDraftChange: (draft: SlackWorkspaceWizardDraft) => void;
  readonly onTokenChange: (token: string) => void;
  readonly onConnect: () => void;
  readonly onRetryChannels: () => void;
  readonly ownerLocked: boolean;
}) {
  return (
    <section aria-labelledby="slack-connect-heading" className="space-y-5">
      <div>
        <h3 className="text-sm font-medium" id="slack-connect-heading">
          1. Connect Slack
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose who owns the workspace, validate the bot token, then select the first channel to
          watch.
        </p>
      </div>

      <label className="block space-y-1.5">
        <span className="text-xs font-medium">Owner</span>
        <Select
          disabled={ownerLocked}
          onValueChange={(ownerId) => {
            if (ownerId === null || ownerLocked) return;
            onTokenChange("");
            onDraftChange({ ...createEmptySlackWorkspaceDraft(), ownerId });
          }}
          value={draft.ownerId}
        >
          <SelectTrigger>
            <SelectValue placeholder="Choose personal or company" />
          </SelectTrigger>
          <SelectPopup>
            {owners.map((owner) => (
              <SelectItem disabled={!owner.canManage} key={owner.id} value={owner.id}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="truncate">{owner.name}</span>
                  <Badge size="sm" variant="outline">
                    {owner.kind === "personal" ? "Personal" : "Company"}
                  </Badge>
                </span>
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {owners.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No personal or company workspace is available.
          </p>
        ) : null}
        {selectedOwner?.unavailableReason ? (
          <p className="text-[11px] text-warning-foreground">{selectedOwner.unavailableReason}</p>
        ) : null}
        {ownerLocked ? (
          <p className="text-[11px] text-muted-foreground">
            Ownership is fixed after Slack validates the workspace. Cross-owner moves require a
            separate migration.
          </p>
        ) : selectedOwner?.kind === "personal" ? (
          <p className="text-[11px] text-muted-foreground">
            Choose Personal for a workspace that is not owned by a company.
          </p>
        ) : null}
      </label>

      {!draft.workspace ? (
        <div className="space-y-2">
          <label className="block space-y-1.5">
            <span className="text-xs font-medium">Slack bot token</span>
            <Input
              autoComplete="off"
              disabled={!selectedOwner?.canManage || channelState === "loading"}
              onChange={(event) => onTokenChange(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && token.trim()) onConnect();
              }}
              placeholder="xoxb-…"
              type="password"
              value={token}
            />
          </label>
          <div className="flex items-center justify-between gap-3">
            <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
              <LockIcon className="size-3" /> Encrypted before storage; no reversible token hint is
              kept.
            </p>
            <Button
              disabled={!selectedOwner?.canManage || !token.trim() || channelState === "loading"}
              onClick={onConnect}
              size="sm"
              type="button"
            >
              {channelState === "loading" ? (
                <Spinner className="size-4" />
              ) : (
                <SlackIcon className="size-4" />
              )}{" "}
              Connect
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex items-start gap-3 rounded-xl border border-border/70 px-3 py-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-muted">
            <SlackIcon className="size-4" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{draft.workspace.name}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {draft.workspace.domain ? `${draft.workspace.domain}.slack.com` : draft.workspace.id}
            </span>
          </span>
          <Badge variant="success">Connected</Badge>
        </div>
      )}

      {draft.workspace ? (
        <label className="block space-y-1.5">
          <span className="text-xs font-medium">First watched channel</span>
          {channelState === "loading" ? (
            <div className="flex min-h-16 items-center justify-center gap-2 rounded-lg border border-dashed text-xs text-muted-foreground">
              <Spinner className="size-4" /> Loading channels…
            </div>
          ) : channelState === "error" ? (
            <div className="flex min-h-16 items-center justify-between gap-3 rounded-lg border border-dashed px-3 text-xs text-muted-foreground">
              Channels could not be loaded.
              <Button onClick={onRetryChannels} size="xs" type="button" variant="outline">
                <RefreshCwIcon /> Retry
              </Button>
            </div>
          ) : channelState === "ready" && channels.length === 0 ? (
            <div className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
              No channels are visible to this Slack bot. Invite it to a channel, then retry.
            </div>
          ) : (
            <Select
              onValueChange={(channelId) => {
                const channel = channels.find((candidate) => candidate.id === channelId);
                onDraftChange({
                  ...draft,
                  channelId,
                  channelName: channel?.name ?? null,
                  watchId: draft.channelId === channelId ? draft.watchId : null,
                  watchRevision: draft.channelId === channelId ? draft.watchRevision : null,
                });
              }}
              value={draft.channelId}
            >
              <SelectTrigger disabled={channels.length === 0}>
                <SelectValue placeholder="Choose a channel" />
              </SelectTrigger>
              <SelectPopup>
                {channels.map((channel) => (
                  <SelectItem key={channel.id} value={channel.id}>
                    <span className="flex items-center gap-2">
                      <HashIcon className="size-3.5" /> {channel.name}
                      {channel.isPrivate ? <LockIcon className="size-3" /> : null}
                    </span>
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          )}
          <p className="text-[11px] text-muted-foreground">
            You can add more channels after this setup is active.
          </p>
        </label>
      ) : null}
    </section>
  );
}

function RouteIssuesStep({
  draft,
  catalog,
  validationContext,
  expandedRuleId,
  onDraftChange,
  onExpandedRuleChange,
}: {
  readonly draft: SlackWorkspaceWizardDraft;
  readonly catalog: SlackOwnerCatalog;
  readonly validationContext: SlackWizardValidationContext;
  readonly expandedRuleId: string | null;
  readonly onDraftChange: (draft: SlackWorkspaceWizardDraft) => void;
  readonly onExpandedRuleChange: (ruleId: string | null) => void;
}) {
  return (
    <section aria-labelledby="slack-routing-heading" className="space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium" id="slack-routing-heading">
            2. Route issues
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Build ordered conditions and choose where each matching message becomes an issue.
          </p>
        </div>
        <Button
          onClick={() => {
            const rule = createDefaultSlackRoutingRule(createViewId("route"));
            onDraftChange({ ...draft, rules: [...draft.rules, rule] });
            onExpandedRuleChange(rule.id);
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          <PlusIcon /> Route
        </Button>
      </div>

      {draft.rules.length === 0 ? (
        <button
          className="w-full rounded-xl border border-dashed px-4 py-8 text-center outline-none hover:bg-muted/30 focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            const rule = createDefaultSlackRoutingRule(createViewId("route"));
            onDraftChange({ ...draft, rules: [rule] });
            onExpandedRuleChange(rule.id);
          }}
          type="button"
        >
          <PlusIcon className="mx-auto mb-2 size-5 text-muted-foreground" />
          <span className="block text-sm font-medium">Add the first route</span>
          <span className="mt-1 block text-xs text-muted-foreground">
            Unmatched Slack messages are ignored.
          </span>
        </button>
      ) : (
        <div className="space-y-2">
          {draft.rules.map((rule, index) => (
            <SlackRouteRuleEditor
              cycles={catalog.cycles ?? []}
              error={slackRuleError(rule, validationContext)}
              expanded={expandedRuleId === rule.id}
              index={index}
              key={rule.id}
              onChange={(update) =>
                onDraftChange({ ...draft, rules: updateRule(draft.rules, rule.id, update) })
              }
              onDelete={() => {
                const rules = draft.rules.filter((candidate) => candidate.id !== rule.id);
                onDraftChange({ ...draft, rules });
                if (expandedRuleId === rule.id)
                  onExpandedRuleChange(rules[index]?.id ?? rules[index - 1]?.id ?? null);
              }}
              onExpandedChange={(expanded) => onExpandedRuleChange(expanded ? rule.id : null)}
              onMove={(direction) =>
                onDraftChange({ ...draft, rules: moveRule(draft.rules, index, direction) })
              }
              projects={catalog.projects}
              rule={rule}
              ruleCount={draft.rules.length}
              statuses={catalog.statuses}
              teams={catalog.teams}
            />
          ))}
        </div>
      )}

      {draft.rules.length > 1 ? (
        <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
          <RotateCcwIcon className="mt-0.5 size-3 shrink-0" /> Reaction-only routes wait up to 60
          seconds before a lower catch-all route claims the message.
        </p>
      ) : null}
      {slackRoutingRulesError(draft.rules, validationContext) ? (
        <span className="sr-only" role="status">
          Routing configuration is incomplete.
        </span>
      ) : null}
    </section>
  );
}

function AutomateAndActivateStep({
  draft,
  catalog,
  readiness,
  readinessState,
  activationStages,
  activationState,
  onDraftChange,
  onRetryReadiness,
}: {
  readonly draft: SlackWorkspaceWizardDraft;
  readonly catalog: SlackOwnerCatalog;
  readonly readiness: readonly SlackWizardReadiness[];
  readonly readinessState: AsyncState;
  readonly activationStages: readonly SlackActivationStage[];
  readonly activationState: AsyncState;
  readonly onDraftChange: (draft: SlackWorkspaceWizardDraft) => void;
  readonly onRetryReadiness: () => void;
}) {
  return (
    <section aria-labelledby="slack-automation-heading" className="space-y-5">
      <div>
        <h3 className="text-sm font-medium" id="slack-automation-heading">
          3. Automate & activate
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose investigation and assignment timing, review readiness, then activate the workspace.
        </p>
      </div>

      <div className="space-y-4">
        {draft.rules.map((rule, index) => (
          <SlackRuleAutomationEditor
            index={index}
            key={rule.id}
            onChange={(update) =>
              onDraftChange({ ...draft, rules: updateRule(draft.rules, rule.id, update) })
            }
            projects={catalog.projects}
            rule={rule}
            statuses={catalog.statuses}
          />
        ))}
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <h4 className="text-xs font-medium">Activation readiness</h4>
          <Button
            disabled={readinessState === "loading" || activationState === "loading"}
            onClick={onRetryReadiness}
            size="xs"
            type="button"
            variant="ghost"
          >
            <RefreshCwIcon /> Check again
          </Button>
        </div>
        {readinessState === "loading" ? (
          <div className="flex min-h-16 items-center justify-center gap-2 rounded-lg border border-dashed text-xs text-muted-foreground">
            <Spinner className="size-4" /> Checking projects, workflows, and controllers…
          </div>
        ) : readinessState === "error" ? (
          <div className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
            Readiness checks could not be loaded. Check your cloud connection and try again.
          </div>
        ) : readiness.length === 0 ? (
          <div className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
            No additional readiness checks are required.
          </div>
        ) : (
          <ul className="divide-y divide-border/60 rounded-xl border border-border/70" role="list">
            {readiness.map((item) => (
              <li className="flex items-start gap-2.5 px-3 py-2.5" key={item.id}>
                <span className="mt-0.5">{readinessIcon(item.state)}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium">{item.label}</span>
                  <span className="block text-[11px] text-muted-foreground">{item.detail}</span>
                </span>
                <Badge
                  size="sm"
                  variant={
                    item.state === "ready"
                      ? "success"
                      : item.state === "blocked"
                        ? "error"
                        : "warning"
                  }
                >
                  {item.state === "ready"
                    ? "Ready"
                    : item.state === "blocked"
                      ? "Blocked"
                      : "Warning"}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <h4 className="text-xs font-medium">Activation</h4>
        <ol className="space-y-2" aria-label="Slack activation progress">
          {activationStages.map((stage) => (
            <li className="flex items-start gap-2 text-xs" key={stage.id}>
              <span className="mt-0.5">{activationIcon(stage.state)}</span>
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    "block",
                    stage.state === "pending" ? "text-muted-foreground" : "font-medium",
                  )}
                >
                  {stage.label}
                </span>
                {stage.detail ? (
                  <span className="block text-[11px] text-muted-foreground">{stage.detail}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
        <p className="text-[11px] text-muted-foreground">
          Activation waits for the first healthy poll. A timeout leaves intake active with a visible
          warning so no saved setup is lost.
        </p>
      </div>
    </section>
  );
}
