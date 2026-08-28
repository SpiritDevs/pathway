import {
  CloudProjectSyncEntity,
  EnvironmentBindingEntity,
  IssueCycleEntity,
  IssueEntity,
  IssueStatusEntity,
  TeamEntity,
} from "@spiritdevs/client-runtime/sync";
import {
  CompanySlackRoutingRuleId,
  IssueCycleId,
  IssueStatusId,
  SlackEmojiName,
  type CompanySlackRoutingCondition,
  type CompanySlackRoutingRule,
  type IssueAutomationSettings,
} from "@spiritdevs/contracts";
import { CloudProjectId } from "@spiritdevs/contracts/cloudProject";
import { CompanyId, TeamId } from "@spiritdevs/contracts/company";
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
  type CompanySlackWatchDefinitionSummary,
  type CompanySlackWatchSummary,
} from "../../../cloud/companyIntegrations";
import { useCompanyIntegrationsClient } from "../../../cloud/useCompanyIntegrationsClient";
import { usePrimarySettings } from "../../../hooks/useSettings";
import { randomUUID } from "../../../lib/utils";
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
import {
  companyDirectoryFromReplicaValues,
  deriveCurrentMemberPermissions,
  permissionGate,
} from "../company/companySettings.logic";
import { environmentRegistrationsFromReplicaValues } from "../company/environmentSettings.logic";
import { CompanySectionCard, CompanySettingsEmptyState } from "../company/CompanySettingsShared";
import { CompanySettingsSheet } from "../company/CompanySettingsSheet";
import { useCompanySettings } from "../company/useCompanySettings";
import {
  createEmptySlackWorkspaceDraft,
  normalizeSlackPrefix,
  normalizeSlackReaction,
  type SlackConditionNode,
  type SlackOwnerCatalog,
  type SlackOwnerOption,
  type SlackRoutingRule,
  type SlackWorkspaceWizardDraft,
  type SlackWizardReadiness,
} from "./slackWorkspaceWizard.logic";
import {
  SlackWorkspaceWizardSheet,
  type SlackWorkspaceActivationResult,
  type SlackWizardAutomationContext,
} from "./SlackWorkspaceWizardSheet";

type SheetState =
  | {
      readonly kind: "add";
      readonly ownerId: CompanyId;
      readonly integrationId: string | null;
    }
  | { readonly kind: "slack"; readonly integrationId: string; readonly view: SlackView }
  | { readonly kind: "automation" }
  | null;
type SlackView = "overview" | "channels" | "channel" | "controllers" | "health" | "danger";

const isProject = Schema.is(CloudProjectSyncEntity);
const isBinding = Schema.is(EnvironmentBindingEntity);
const isCycle = Schema.is(IssueCycleEntity);
const isIssue = Schema.is(IssueEntity);
const isStatus = Schema.is(IssueStatusEntity);
const isTeam = Schema.is(TeamEntity);

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

function conditionFromContract(
  condition: CompanySlackRoutingCondition,
  id: string,
): SlackConditionNode {
  switch (condition.kind) {
    case "all":
    case "any":
      return {
        id,
        type: "group",
        operator: condition.kind,
        children: condition.conditions.map((child, index) =>
          conditionFromContract(child, `${id}:${index}`),
        ),
      };
    case "text-prefix":
      return { id, type: "prefix", prefixes: condition.prefixes };
    case "reaction":
      return { id, type: "reaction", emoji: condition.emoji };
    case "bot-mention":
      return { id, type: "botMention" };
    case "every-message":
      return { id, type: "everyMessage" };
  }
}

function conditionToContract(condition: SlackConditionNode): CompanySlackRoutingCondition {
  switch (condition.type) {
    case "group":
      return {
        kind: condition.operator,
        conditions: condition.children.map(conditionToContract),
      };
    case "prefix":
      return {
        kind: "text-prefix",
        prefixes: condition.prefixes.map(normalizeSlackPrefix).filter(Boolean),
      };
    case "reaction":
      return {
        kind: "reaction",
        emoji: SlackEmojiName.make(normalizeSlackReaction(condition.emoji)),
      };
    case "botMention":
      return { kind: "bot-mention" };
    case "everyMessage":
      return { kind: "every-message" };
  }
}

function ruleFromContract(rule: CompanySlackRoutingRule): SlackRoutingRule {
  const condition = conditionFromContract(rule.condition, `${rule.id}:condition`);
  return {
    id: rule.id,
    name: rule.name,
    condition:
      condition.type === "group"
        ? condition
        : {
            id: `${rule.id}:condition-root`,
            type: "group",
            operator: "all",
            children: [condition],
          },
    teamId: rule.teamId,
    projectId: rule.cloudProjectId,
    cycleId: rule.cycleId,
    initialPlacement:
      rule.initialStatusId === null
        ? { kind: "triage" }
        : { kind: "status", statusId: rule.initialStatusId },
    investigation:
      rule.investigation.timing === "off"
        ? { kind: "off" }
        : rule.investigation.timing === "immediate"
          ? {
              kind: "immediate",
              successStatusId: rule.investigation.successStatusId,
            }
          : {
              kind: "status",
              triggerStatusId: rule.investigation.triggerStatusId ?? "",
              successStatusId: rule.investigation.successStatusId,
            },
    assignment: rule.assignmentTiming,
  };
}

function ruleToContract(rule: SlackRoutingRule): CompanySlackRoutingRule {
  return {
    id: CompanySlackRoutingRuleId.make(rule.id),
    name: rule.name.trim(),
    condition: conditionToContract(rule.condition),
    teamId: rule.teamId === null ? null : TeamId.make(rule.teamId),
    cloudProjectId: rule.projectId === null ? null : CloudProjectId.make(rule.projectId),
    cycleId: rule.cycleId === null ? null : IssueCycleId.make(rule.cycleId),
    initialStatusId:
      rule.initialPlacement.kind === "triage"
        ? null
        : IssueStatusId.make(rule.initialPlacement.statusId),
    investigation:
      rule.investigation.kind === "off"
        ? { timing: "off", triggerStatusId: null, successStatusId: null }
        : rule.investigation.kind === "immediate"
          ? {
              timing: "immediate",
              triggerStatusId: null,
              successStatusId:
                rule.investigation.successStatusId === null
                  ? null
                  : IssueStatusId.make(rule.investigation.successStatusId),
            }
          : {
              timing: "on-status",
              triggerStatusId: IssueStatusId.make(rule.investigation.triggerStatusId),
              successStatusId:
                rule.investigation.successStatusId === null
                  ? null
                  : IssueStatusId.make(rule.investigation.successStatusId),
            },
    assignmentTiming: rule.assignment,
  };
}

function legacyRulesFromWatch(watch: CompanySlackWatchSummary): readonly SlackRoutingRule[] {
  const shared = {
    teamId: null,
    cycleId: watch.cycleId,
    initialPlacement: { kind: "triage" } as const,
    investigation: watch.autoInvestigate
      ? ({ kind: "immediate", successStatusId: null } as const)
      : ({ kind: "off" } as const),
    assignment: watch.autoAssign ? ("immediate" as const) : ("off" as const),
  };
  const rules: SlackRoutingRule[] = watch.trigger.reactionRoutes.map((route, index) => ({
    id: `${watch.id}:reaction:${index}`,
    name: `Reaction :${route.emoji}:`,
    condition: {
      id: `${watch.id}:reaction:${index}:root`,
      type: "group",
      operator: "all",
      children: [
        { id: `${watch.id}:reaction:${index}:leaf`, type: "reaction", emoji: route.emoji },
      ],
    },
    ...shared,
    projectId: route.cloudProjectId ?? watch.cloudProjectId,
    investigation:
      route.autoInvestigate === null
        ? shared.investigation
        : route.autoInvestigate
          ? { kind: "immediate", successStatusId: null }
          : { kind: "off" },
  }));
  if (watch.trigger.botMention) {
    rules.push({
      id: `${watch.id}:mention`,
      name: "Bot mentions",
      condition: {
        id: `${watch.id}:mention:root`,
        type: "group",
        operator: "all",
        children: [{ id: `${watch.id}:mention:leaf`, type: "botMention" }],
      },
      ...shared,
      projectId: watch.cloudProjectId,
    });
  }
  if (watch.trigger.everyMessage) {
    rules.push({
      id: `${watch.id}:every-message`,
      name: "Everything else",
      condition: {
        id: `${watch.id}:every-message:root`,
        type: "group",
        operator: "all",
        children: [{ id: `${watch.id}:every-message:leaf`, type: "everyMessage" }],
      },
      ...shared,
      projectId: watch.cloudProjectId,
    });
  }
  return rules;
}

function draftFromIntegration(
  ownerId: CompanyId,
  integration: CompanySlackIntegrationSummary,
  definitions: readonly CompanySlackWatchDefinitionSummary[],
): SlackWorkspaceWizardDraft {
  const definition = definitions[0] ?? null;
  return {
    integrationId: integration.id,
    integrationRevision: integration.configurationRevision,
    ownerId,
    workspace: {
      id: integration.workspaceId,
      name: integration.workspaceName,
      domain: integration.workspaceDomain,
    },
    channelId: definition?.channelId ?? null,
    channelName: definition?.channelName ?? null,
    watchId: definition?.id ?? null,
    watchRevision: definition?.revision ?? null,
    preferredEnvironmentId: integration.preferredEnvironmentId,
    backupEnvironmentIds: integration.backupEnvironmentIds,
    rules:
      definition === null
        ? []
        : "configurationVersion" in definition
          ? definition.rules.map(ruleFromContract)
          : legacyRulesFromWatch(definition),
  };
}

function wizardEntityId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

function SlackWorkspaceWizardController({
  client,
  ownerId,
  integrationId,
  automation,
  automationFallback,
  canManage,
  owners,
  ownerCatalogs,
  ownerEnvironmentIds,
  onClose,
  onChanged,
}: {
  readonly client: CompanyIntegrationsClient;
  readonly ownerId: CompanyId;
  readonly integrationId: string | null;
  readonly automation: CompanyAutomationSettingsSummary | null;
  readonly automationFallback: IssueAutomationSettings;
  readonly canManage: boolean;
  readonly owners: readonly SlackOwnerOption[];
  readonly ownerCatalogs: ReadonlyMap<string, SlackOwnerCatalog>;
  readonly ownerEnvironmentIds: ReadonlyMap<string, readonly string[]>;
  readonly onClose: () => void;
  readonly onChanged: (ownerId: CompanyId) => Promise<void>;
}) {
  const [initialDraft, setInitialDraft] = useState<SlackWorkspaceWizardDraft | null>(
    integrationId === null ? { ...createEmptySlackWorkspaceDraft(), ownerId } : null,
  );
  const [integrationState, setIntegrationState] = useState<"draft" | "active" | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (integrationId === null) {
      setInitialDraft({ ...createEmptySlackWorkspaceDraft(), ownerId });
      setIntegrationState(null);
      return () => {
        cancelled = true;
      };
    }
    setInitialDraft(null);
    setLoadError(null);
    void Promise.all([
      client.getIntegration(ownerId, integrationId),
      client.listWatchDefinitions(ownerId, integrationId),
    ])
      .then(([integration, definitions]) => {
        if (cancelled) return;
        if (integration === null) throw new Error("This Slack integration no longer exists.");
        setIntegrationState(integration.state === "active" ? "active" : "draft");
        setInitialDraft(draftFromIntegration(ownerId, integration, definitions));
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Could not load the Slack draft.");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [client, integrationId, ownerId]);

  const saveDraft = useCallback(
    async (draft: SlackWorkspaceWizardDraft): Promise<SlackWorkspaceWizardDraft> => {
      if (draft.ownerId === null || draft.integrationId === null) {
        throw new Error("Connect Slack before saving routing rules.");
      }
      if (draft.channelId === null || draft.channelName === null) {
        throw new Error("Choose a Slack channel before saving routing rules.");
      }
      if (draft.preferredEnvironmentId === null) {
        throw new Error("Choose the primary environment that will run this Slack listener.");
      }
      const companyId = CompanyId.make(draft.ownerId);
      const saveControllerPool = () =>
        client.setControllerPool({
          companyId,
          integrationId: draft.integrationId!,
          preferredEnvironmentId: draft.preferredEnvironmentId,
          backupEnvironmentIds: draft.backupEnvironmentIds,
        });
      if (draft.watchId === null) {
        const definitions = await client.listWatchDefinitions(companyId, draft.integrationId);
        const existing = definitions.find((definition) => definition.channelId === draft.channelId);
        if (existing !== undefined) {
          await saveControllerPool();
          await onChanged(companyId);
          return {
            ...draft,
            channelName: existing.channelName,
            watchId: existing.id,
            watchRevision: existing.revision,
            rules:
              "configurationVersion" in existing
                ? existing.rules.map(ruleFromContract)
                : legacyRulesFromWatch(existing),
          };
        }
      }
      const saved = await client.saveV2Watch({
        companyId,
        integrationId: draft.integrationId,
        id: draft.watchId ?? wizardEntityId("slack-watch"),
        channelId: draft.channelId,
        channelName: draft.channelName,
        rules: draft.rules.map(ruleToContract),
        expectedRevision: draft.watchRevision,
      });
      await saveControllerPool();
      const nextDraft = {
        ...draft,
        watchId: saved.id,
        watchRevision: saved.revision,
      };
      await onChanged(companyId);
      return nextDraft;
    },
    [client, onChanged],
  );

  if (initialDraft === null) {
    return (
      <CompanySettingsSheet
        description="Loading the saved Slack workspace and routing draft."
        footer={
          <Button onClick={onClose} variant="outline">
            Close
          </Button>
        }
        onOpenChange={(open) => !open && onClose()}
        open
        title="Slack workspace"
      >
        {loadError === null ? (
          <div className="p-8 text-center text-xs text-muted-foreground">Loading Slack setup…</div>
        ) : (
          <CompanySettingsEmptyState title="Could not load Slack setup" description={loadError} />
        )}
      </CompanySettingsSheet>
    );
  }

  return (
    <SlackWorkspaceWizardSheet
      getOwnerCatalog={(selectedOwnerId) =>
        ownerCatalogs.get(selectedOwnerId) ?? {
          environments: [],
          teams: [],
          statuses: [],
          projects: [],
          cycles: [],
        }
      }
      initialDraft={initialDraft}
      initialAutomation={{
        ownerId,
        settings: automation?.settings ?? automationFallback,
        configured: automation !== null,
        enabled: automation?.enabled ?? false,
      }}
      mode={
        integrationState === "active" ? "active" : integrationState === "draft" ? "draft" : "new"
      }
      onActivate={async (draft, reportProgress): Promise<SlackWorkspaceActivationResult> => {
        reportProgress("configuration", "running", "Saving the latest workspace settings.");
        const saved = await saveDraft(draft);
        reportProgress("configuration", "complete");
        reportProgress("routing", "complete", `${saved.rules.length} routing rules published.`);

        const selectedOwnerId = CompanyId.make(saved.ownerId!);
        const integration = await client.getIntegration(selectedOwnerId, saved.integrationId!);
        if (integration === null) throw new Error("The Slack integration no longer exists.");
        reportProgress("controller", "running", "Confirming the listener environments.");
        const candidates = ownerEnvironmentIds.get(selectedOwnerId) ?? [];
        const selectedControllers = [
          saved.preferredEnvironmentId,
          ...saved.backupEnvironmentIds,
        ].filter((environmentId): environmentId is string => environmentId !== null);
        if (
          saved.preferredEnvironmentId === null ||
          selectedControllers.some((environmentId) => !candidates.includes(environmentId))
        ) {
          throw new Error("One or more selected listener environments are no longer connected.");
        }
        reportProgress(
          "controller",
          "complete",
          saved.backupEnvironmentIds.length === 0
            ? "Primary listener confirmed."
            : "Primary and backup listeners confirmed.",
        );
        await client.activate({
          companyId: selectedOwnerId,
          integrationId: saved.integrationId!,
          legacyWatchersAcknowledged: true,
          enableAutomation: true,
        });

        reportProgress("health", "running", "Waiting for the first healthy Slack poll.");
        const startedAt = Date.now();
        for (let attempt = 0; attempt < 15; attempt += 1) {
          const current = await client.getIntegration(selectedOwnerId, saved.integrationId!);
          if (
            current?.lastPollAt !== null &&
            current?.lastPollAt !== undefined &&
            current.lastPollAt >= startedAt
          ) {
            if (current.currentError === null) {
              reportProgress("health", "complete", "The controller completed a healthy poll.");
              return { outcome: "healthy" };
            }
            reportProgress("health", "warning", current.currentError);
            return { outcome: "active-warning", message: current.currentError };
          }
          await new Promise((resolve) => globalThis.setTimeout(resolve, 1_000));
        }
        reportProgress("health", "warning", "The first poll is still pending.");
        return {
          outcome: "active-warning",
          message: "Slack intake is active. The first health check is still pending.",
        };
      }}
      onCheckReadiness={async (draft): Promise<readonly SlackWizardReadiness[]> => {
        if (draft.ownerId === null) return [];
        const selectedOwnerId = CompanyId.make(draft.ownerId);
        const catalog = ownerCatalogs.get(selectedOwnerId);
        const automationRules = draft.rules.filter(
          (rule) => rule.investigation.kind !== "off" || rule.assignment !== "off",
        );
        const preferredEnvironmentId = draft.preferredEnvironmentId;
        const unavailableProjects = automationRules.filter((rule) => {
          const project = catalog?.projects.find((candidate) => candidate.id === rule.projectId);
          return (
            project?.ready !== true ||
            preferredEnvironmentId === null ||
            !project.environmentIds.includes(preferredEnvironmentId)
          );
        });
        const checkedAutomation =
          automationRules.length === 0 ? null : await client.getAutomation(selectedOwnerId);
        const environments = ownerEnvironmentIds.get(selectedOwnerId) ?? [];
        const selectedControllers = [preferredEnvironmentId, ...draft.backupEnvironmentIds].filter(
          (environmentId): environmentId is string => environmentId !== null,
        );
        const controllersReady =
          preferredEnvironmentId !== null &&
          selectedControllers.every((environmentId) => environments.includes(environmentId));
        return [
          {
            id: "projects",
            label: "Automation projects",
            state: unavailableProjects.length === 0 ? "ready" : "blocked",
            detail:
              unavailableProjects.length === 0
                ? "Every automated route has an available project checkout."
                : `${unavailableProjects.length} automated routes need an available project checkout.`,
          },
          {
            id: "automation",
            label: "Issue automation",
            state:
              automationRules.length === 0 || checkedAutomation?.enabled === true
                ? "ready"
                : checkedAutomation === null
                  ? "blocked"
                  : "warning",
            detail:
              automationRules.length === 0
                ? "No route requires investigation or assignment."
                : checkedAutomation === null
                  ? "Configure issue automation before activating these routes."
                  : checkedAutomation.enabled
                    ? "Issue automation is enabled."
                    : "Issue automation will be enabled during activation.",
          },
          {
            id: "controller",
            label: "Listener environments",
            state: controllersReady ? "ready" : "blocked",
            detail:
              preferredEnvironmentId === null
                ? "Choose the primary environment that will poll Slack."
                : controllersReady
                  ? draft.backupEnvironmentIds.length === 0
                    ? "The primary listener is connected."
                    : "The primary and backup listeners are connected."
                  : "A selected listener environment is no longer connected.",
          },
        ];
      }}
      onLoadAutomation={async (selectedOwnerId): Promise<SlackWizardAutomationContext> => {
        const selectedCompanyId = CompanyId.make(selectedOwnerId);
        const summary = await client.getAutomation(selectedCompanyId);
        return {
          ownerId: selectedOwnerId,
          settings: summary?.settings ?? automationFallback,
          configured: summary !== null,
          enabled: summary?.enabled ?? false,
        };
      }}
      onSaveAutomation={async (
        selectedOwnerId,
        settings,
      ): Promise<SlackWizardAutomationContext> => {
        if (!canManage) {
          throw new Error(
            "The integrations.manage permission is required to configure issue automation.",
          );
        }
        const selectedCompanyId = CompanyId.make(selectedOwnerId);
        const current = await client.getAutomation(selectedCompanyId);
        const saved = await client.saveAutomation({
          companyId: selectedCompanyId,
          settings,
          expectedRevision: current?.revision ?? null,
        });
        await onChanged(selectedCompanyId);
        return {
          ownerId: selectedOwnerId,
          settings: saved.settings,
          configured: true,
          enabled: saved.enabled,
        };
      }}
      onComplete={(draft) => {
        if (draft.ownerId !== null) void onChanged(CompanyId.make(draft.ownerId));
      }}
      onConnect={async ({ ownerId: selectedOwnerId, token }) => {
        const companyId = CompanyId.make(selectedOwnerId);
        if (integrationId !== null && companyId !== ownerId) {
          throw new Error(
            "This Slack workspace is already owned by another account. Cross-owner moves require a separate migration.",
          );
        }
        const result = await client.connect(
          companyId,
          token,
          companyId === ownerId && integrationId !== null ? integrationId : undefined,
        );
        await onChanged(companyId);
        return {
          integrationId: result.id,
          workspace: {
            id: result.workspaceId,
            name: result.workspaceName,
            domain: result.workspaceDomain,
          },
        };
      }}
      {...(integrationState === "draft"
        ? {
            onDeleteDraft: async (draft: SlackWorkspaceWizardDraft) => {
              if (draft.ownerId === null || draft.integrationId === null) return;
              const companyId = CompanyId.make(draft.ownerId);
              const current = await client.getIntegration(companyId, draft.integrationId);
              if (current === null) return;
              await client.deleteDraft({
                companyId,
                integrationId: draft.integrationId,
                expectedRevision: current.configurationRevision,
              });
              await onChanged(companyId);
            },
          }
        : {})}
      onListChannels={({ ownerId: selectedOwnerId, integrationId: selectedIntegrationId }) =>
        client.discoverChannels(CompanyId.make(selectedOwnerId), selectedIntegrationId)
      }
      onOpenChange={(open) => !open && onClose()}
      onSaveDraft={saveDraft}
      open
      owners={owners}
    />
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
    watch?.trigger.reactionRoutes.map((route) => ({
      ...route,
      clientKey: wizardEntityId("route"),
    })) ?? [],
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
            .map((route) => ({
              emoji: route.emoji.trim().replaceAll(":", ""),
              cloudProjectId: route.cloudProjectId,
              autoInvestigate: route.autoInvestigate,
            }))
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
                {
                  emoji: "",
                  cloudProjectId: null,
                  autoInvestigate: null,
                  clientKey: wizardEntityId("route"),
                },
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
              key={route.clientKey}
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
              {integration.healthHistory.toReversed().map((event) => (
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

function LegacyPersonalIntegrationsPanel() {
  const status = useSlackStatus();
  const watches = useSlackWatches();
  const [open, setOpen] = useState<"slack" | "automation" | null>(null);
  if (!status.configured) return null;
  return (
    <>
      <SettingsSection {...searchableSetting("issue-intake")}>
        <div className="mb-3 flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Legacy local integration</p>
            <p className="text-xs text-muted-foreground">
              This older Slack setup remains on this environment until you migrate or remove it.
            </p>
          </div>
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
                <Badge variant="success">Connected locally</Badge>
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
    </>
  );
}

export function IntegrationsSettingsPanel() {
  const company = useCompanySettings();
  const localSettings = usePrimarySettings();
  const client = useCompanyIntegrationsClient();
  const filteredCompany = company.activeCompany ?? company.personalCompany;
  const filteredCompanyId = filteredCompany?.id ?? null;
  const [integrations, setIntegrations] = useState<ReadonlyArray<CompanySlackIntegrationSummary>>(
    [],
  );
  const [automation, setAutomation] = useState<CompanyAutomationSettingsSummary | null>(null);
  const [jobs, setJobs] = useState<ReadonlyArray<CompanyAutomationJobSummary>>([]);
  const [loadedCompanyId, setLoadedCompanyId] = useState(filteredCompanyId);
  const [sheet, setSheet] = useState<SheetState>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [automationLoadError, setAutomationLoadError] = useState<string | null>(null);
  const [openingIntegrationId, setOpeningIntegrationId] = useState<string | null>(null);
  const refreshVersionRef = useRef(0);
  const companyIdRef = useRef(filteredCompanyId);
  companyIdRef.current = filteredCompanyId;
  const sheetCompanyIdRef = useRef(filteredCompanyId);
  const ownerContexts = useMemo(() => {
    const contexts = new Map<
      string,
      {
        readonly catalog: SlackOwnerCatalog;
        readonly environmentIds: readonly string[];
        readonly permissions: ReturnType<typeof deriveCurrentMemberPermissions>;
      }
    >();
    for (const owner of company.companies) {
      const replica = company.registryReplicas.get(owner.id);
      const ownerValues = [...(replica?.view.values() ?? [])];
      const directory = companyDirectoryFromReplicaValues(ownerValues);
      const membershipId = company.registryMembershipIds.get(owner.id) ?? null;
      const permissions = deriveCurrentMemberPermissions({
        directory,
        membershipId,
        isOwner:
          membershipId === null
            ? null
            : (directory.company?.owners.some((entry) => entry.membershipId === membershipId) ??
              false),
      });
      const environments = environmentRegistrationsFromReplicaValues(ownerValues)
        .filter((row) => row.state === "active")
        .map((row) => ({
          id: row.environmentId,
          name:
            typeof row.descriptor === "object" &&
            row.descriptor !== null &&
            "name" in row.descriptor &&
            typeof row.descriptor.name === "string"
              ? row.descriptor.name
              : row.environmentId,
        }));
      const environmentIds = environments.map((environment) => environment.id);
      const activeEnvironmentIds = new Set(environmentIds);
      const activeBindings = ownerValues
        .filter(isBinding)
        .filter(
          (binding) =>
            binding.status === "active" && activeEnvironmentIds.has(binding.environmentId),
        );
      const environmentIdsByProject = new Map<string, string[]>();
      for (const binding of activeBindings) {
        const current = environmentIdsByProject.get(binding.cloudProjectId) ?? [];
        current.push(binding.environmentId);
        environmentIdsByProject.set(binding.cloudProjectId, current);
      }
      const teams = ownerValues
        .filter(isTeam)
        .filter((team) => team.archivedAt === null)
        .map((team) => ({ id: team.id, name: team.name }));
      const rawStatuses = ownerValues.filter(isStatus).filter((status) => !status.hidden);
      const baseStatuses = rawStatuses.filter(
        (status) => status.teamId === null && status.name !== null,
      );
      const baseStatusById = new Map(baseStatuses.map((status) => [status.id, status]));
      const teamStatuses = rawStatuses
        .filter((status) => status.teamId !== null)
        .flatMap((status) => {
          const base =
            status.baseStatusId === null ? null : baseStatusById.get(status.baseStatusId);
          const name = status.name ?? base?.name ?? null;
          if (name === null) return [];
          return [
            {
              id: status.id,
              name,
              teamId: status.teamId,
              color: status.color ?? base?.color ?? null,
            },
          ];
        });
      const inheritedStatuses = teams.flatMap((team) =>
        baseStatuses
          .filter(
            (base) =>
              !rawStatuses.some(
                (candidate) => candidate.teamId === team.id && candidate.baseStatusId === base.id,
              ),
          )
          .map((status) => ({
            id: status.id,
            name: status.name!,
            teamId: team.id,
            color: status.color ?? null,
          })),
      );
      contexts.set(owner.id, {
        catalog: {
          environments,
          teams,
          statuses: [
            ...baseStatuses.map((status) => ({
              id: status.id,
              name: status.name!,
              teamId: null,
              color: status.color ?? null,
            })),
            ...teamStatuses,
            ...inheritedStatuses,
          ],
          projects: ownerValues
            .filter(isProject)
            .filter((project) => project.archivedAt === null)
            .map((project) => {
              const projectEnvironmentIds = environmentIdsByProject.get(project.id) ?? [];
              return {
                id: project.id,
                name: project.name,
                environmentIds: projectEnvironmentIds,
                ready: projectEnvironmentIds.length > 0,
                readinessDetail:
                  projectEnvironmentIds.length > 0
                    ? "An active checkout is available."
                    : "No connected environment has an active checkout.",
              };
            }),
          cycles: ownerValues
            .filter(isCycle)
            .filter((cycle) => cycle.completedAt === null)
            .map((cycle) => ({ id: cycle.id, name: cycle.name, teamId: cycle.teamId })),
        },
        environmentIds,
        permissions,
      });
    }
    return contexts;
  }, [company.companies, company.registryMembershipIds, company.registryReplicas]);
  const owners = useMemo<readonly SlackOwnerOption[]>(
    () =>
      company.companies.map((owner) => {
        const gate = permissionGate(
          ownerContexts.get(owner.id)?.permissions ?? { status: "unknown" },
          "integrations.manage",
        );
        return {
          id: owner.id,
          name: owner.workspaceKind === "personal" ? "Personal" : owner.name,
          kind: owner.workspaceKind,
          canManage: gate.enabled,
          unavailableReason: gate.enabled ? null : gate.tooltip,
        };
      }),
    [company.companies, ownerContexts],
  );
  const ownerCatalogs = useMemo(
    () => new Map([...ownerContexts].map(([id, context]) => [id, context.catalog])),
    [ownerContexts],
  );
  const ownerEnvironmentIds = useMemo(
    () => new Map([...ownerContexts].map(([id, context]) => [id, context.environmentIds])),
    [ownerContexts],
  );
  const filteredReplica =
    filteredCompanyId === null ? null : (company.registryReplicas.get(filteredCompanyId) ?? null);
  const values = useMemo(() => [...(filteredReplica?.view.values() ?? [])], [filteredReplica]);
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
  const projects = useMemo(() => {
    const activeEnvironmentIds = new Set(
      environments.map((environment) => environment.environmentId),
    );
    const environmentIdsByProject = new Map<string, string[]>();
    for (const binding of values.filter(isBinding)) {
      if (binding.status !== "active" || !activeEnvironmentIds.has(binding.environmentId)) continue;
      const current = environmentIdsByProject.get(binding.cloudProjectId) ?? [];
      current.push(binding.environmentId);
      environmentIdsByProject.set(binding.cloudProjectId, current);
    }
    return values
      .filter(isProject)
      .filter((row) => row.archivedAt === null)
      .map((row) => ({
        id: row.id,
        name: row.name,
        environmentIds: environmentIdsByProject.get(row.id) ?? [],
      }));
  }, [environments, values]);
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
  // Registry replicas publish a fresh Map on every cloud-sync tick, so `ownerContexts` changes
  // identity constantly. Reading it through a ref keeps `refresh` — and the effect that depends on
  // it — from re-running and tearing down an open sheet mid-configuration.
  const ownerContextsRef = useRef(ownerContexts);
  ownerContextsRef.current = ownerContexts;
  const filteredPermissions =
    filteredCompanyId === null
      ? ({ status: "unknown" } as const)
      : (ownerContexts.get(filteredCompanyId)?.permissions ?? { status: "unknown" });
  const readGate = permissionGate(filteredPermissions, "integrations.read");
  const manageGate = permissionGate(filteredPermissions, "integrations.manage");
  const refresh = useCallback(
    async (requestedCompanyId = companyIdRef.current) => {
      if (client === null || requestedCompanyId === null) return;
      const requestedContext = ownerContextsRef.current.get(requestedCompanyId);
      if (
        !permissionGate(requestedContext?.permissions ?? { status: "unknown" }, "integrations.read")
          .enabled
      )
        return;
      const companyId = requestedCompanyId;
      const refreshVersion = ++refreshVersionRef.current;
      const refreshesVisibleCompany = companyId === companyIdRef.current;
      if (refreshesVisibleCompany) {
        setLoading(true);
        setLoadError(null);
        setAutomationLoadError(null);
      }
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
    },
    [client],
  );
  useEffect(() => {
    refreshVersionRef.current += 1;
    // Only a genuine owner switch invalidates an open sheet. A permission or client refresh must
    // never close the Slack wizard, or the workspace can never finish being configured.
    if (sheetCompanyIdRef.current !== filteredCompanyId) {
      sheetCompanyIdRef.current = filteredCompanyId;
      setSheet(null);
    }
    setLoading(true);
    setLoadError(null);
    setAutomationLoadError(null);
    if (filteredCompanyId === null) {
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
  }, [client, filteredCompanyId, readGate.enabled, readGate.tooltip, refresh]);

  const openIntegration = useCallback(
    async (integration: CompanySlackIntegrationSummary) => {
      if (client === null || filteredCompanyId === null || openingIntegrationId !== null) return;
      setOpeningIntegrationId(integration.id);
      try {
        if (integration.state === "draft") {
          setSheet({
            kind: "add",
            ownerId: filteredCompanyId,
            integrationId: integration.id,
          });
          return;
        }
        const definitions = await client.listWatchDefinitions(filteredCompanyId, integration.id);
        const usesV2Routing = definitions.some(
          (definition) => "configurationVersion" in definition,
        );
        setSheet(
          usesV2Routing
            ? {
                kind: "add",
                ownerId: filteredCompanyId,
                integrationId: integration.id,
              }
            : {
                kind: "slack",
                integrationId: integration.id,
                view: "overview",
              },
        );
      } catch (error) {
        reportError("Could not open Slack workspace", error);
      } finally {
        setOpeningIntegrationId(null);
      }
    },
    [client, filteredCompanyId, openingIntegrationId],
  );

  if (filteredCompanyId !== null && !readGate.enabled)
    return (
      <SettingsPageContainer>
        <CompanySettingsEmptyState
          title="Integrations are restricted"
          description={
            readGate.tooltip ?? "You do not have permission to view company integrations."
          }
        />
        <LegacyPersonalIntegrationsPanel />
      </SettingsPageContainer>
    );
  const dataMatchesCompany = loadedCompanyId === filteredCompanyId;
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
            <p className="text-sm font-medium">Slack workspaces</p>
            <p className="text-xs text-muted-foreground">
              {filteredCompany === undefined || filteredCompany === null
                ? "Choose an owner while connecting a Slack workspace."
                : `Showing integrations owned by ${
                    filteredCompany.workspaceKind === "personal" ? "Personal" : filteredCompany.name
                  }. The Settings company selector only filters this list.`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {attention > 0 ? <Badge variant="warning">{attention} need attention</Badge> : null}
            <Button
              size="sm"
              disabled={!manageGate.enabled || client === null || filteredCompanyId === null}
              onClick={() => {
                if (filteredCompanyId === null) return;
                setSheet({ kind: "add", ownerId: filteredCompanyId, integrationId: null });
              }}
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
                disabled={openingIntegrationId !== null}
                onClick={() => void openIntegration(integration)}
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
                    {openingIntegrationId === integration.id
                      ? "Opening workspace…"
                      : `${integration.watchCount} watched channels · `}
                    {openingIntegrationId === integration.id ? null : (
                      <>
                        {integration.controllerEnvironmentId ?? "No controller"} · Polled{" "}
                        {formatAge(integration.lastPollAt)}
                      </>
                    )}
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
      <LegacyPersonalIntegrationsPanel />
      {client !== null && filteredCompanyId !== null ? (
        <>
          {sheet?.kind === "add" ? (
            <SlackWorkspaceWizardController
              automation={visibleAutomation}
              automationFallback={localSettings.issueAutomation}
              canManage={manageGate.enabled}
              client={client}
              integrationId={sheet.integrationId}
              onChanged={async (ownerId) => {
                if (ownerId === filteredCompanyId) await refresh(ownerId);
              }}
              onClose={() => setSheet(null)}
              ownerCatalogs={ownerCatalogs}
              ownerEnvironmentIds={ownerEnvironmentIds}
              ownerId={sheet.ownerId}
              owners={owners}
            />
          ) : null}
          {selected !== null && sheet?.kind === "slack" ? (
            <SlackIntegrationSheet
              client={client}
              companyId={filteredCompanyId}
              integration={selected}
              environments={environments}
              projects={projects.filter(
                (project) =>
                  selected.preferredEnvironmentId !== null &&
                  project.environmentIds.includes(selected.preferredEnvironmentId),
              )}
              cycles={cycles}
              canManage={manageGate.enabled}
              state={sheet}
              onState={(view) => setSheet({ ...sheet, view })}
              onClose={() => setSheet(null)}
              onChanged={() => refresh(filteredCompanyId)}
            />
          ) : null}
          {sheet?.kind === "automation" ? (
            <AutomationSheet
              client={client}
              companyId={filteredCompanyId}
              summary={visibleAutomation}
              jobs={visibleJobs}
              fallback={localSettings.issueAutomation}
              issueKeys={issueKeys}
              canManage={manageGate.enabled}
              onClose={() => setSheet(null)}
              onChanged={() => refresh(filteredCompanyId)}
            />
          ) : null}
        </>
      ) : null}
    </SettingsPageContainer>
  );
}
