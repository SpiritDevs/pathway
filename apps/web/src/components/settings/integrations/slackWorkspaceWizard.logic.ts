export const SLACK_WORKSPACE_WIZARD_STEPS = [
  "Connect Slack",
  "Route issues",
  "Automate routes",
  "Issue automation",
  "Activate",
] as const;

export type SlackWorkspaceWizardStep = 0 | 1 | 2 | 3 | 4;

const BASIC_SLACK_WORKSPACE_WIZARD_STEPS: readonly SlackWorkspaceWizardStep[] = [0, 1, 2, 4];
const AUTOMATED_SLACK_WORKSPACE_WIZARD_STEPS: readonly SlackWorkspaceWizardStep[] = [0, 1, 2, 3, 4];

export const SLACK_ROUTING_LIMITS = {
  rulesPerChannel: 25,
  nodesPerRule: 50,
  nodesPerChannel: 250,
  prefixesPerCondition: 10,
  prefixCharacters: 80,
  serializedBytes: 32 * 1024,
} as const;

export interface SlackOwnerOption {
  readonly id: string;
  readonly name: string;
  readonly kind: "personal" | "organization";
  readonly canManage: boolean;
  readonly unavailableReason?: string | null;
}

export interface SlackWorkspaceIdentity {
  readonly id: string;
  readonly name: string;
  readonly domain: string | null;
}

export interface SlackChannelOption {
  readonly id: string;
  readonly name: string;
  readonly isPrivate?: boolean;
}

export interface SlackTeamOption {
  readonly id: string;
  readonly name: string;
}

export interface SlackStatusOption {
  readonly id: string;
  readonly name: string;
  readonly teamId: string | null;
  readonly color?: string | null;
}

export interface SlackEnvironmentOption {
  readonly id: string;
  readonly name: string;
}

export interface SlackProjectOption {
  readonly id: string;
  readonly name: string;
  readonly environmentIds: readonly string[];
  readonly ready?: boolean;
  readonly readinessDetail?: string | null;
}

export interface SlackCycleOption {
  readonly id: string;
  readonly name: string;
  readonly teamId: string | null;
}

export interface SlackOwnerCatalog {
  readonly environments: readonly SlackEnvironmentOption[];
  readonly teams: readonly SlackTeamOption[];
  readonly statuses: readonly SlackStatusOption[];
  readonly projects: readonly SlackProjectOption[];
  readonly cycles?: readonly SlackCycleOption[];
}

export type SlackConditionLeaf =
  | { readonly id: string; readonly type: "prefix"; readonly prefixes: readonly string[] }
  | { readonly id: string; readonly type: "reaction"; readonly emoji: string }
  | { readonly id: string; readonly type: "botMention" }
  | { readonly id: string; readonly type: "everyMessage" };

export interface SlackConditionGroup {
  readonly id: string;
  readonly type: "group";
  readonly operator: "all" | "any";
  readonly children: readonly SlackConditionNode[];
}

export type SlackConditionNode = SlackConditionLeaf | SlackConditionGroup;

export type SlackInitialPlacement =
  | { readonly kind: "triage" }
  | { readonly kind: "status"; readonly statusId: string };

export type SlackInvestigationPolicy =
  | { readonly kind: "off" }
  | { readonly kind: "immediate"; readonly successStatusId: string | null }
  | {
      readonly kind: "status";
      readonly triggerStatusId: string;
      readonly successStatusId: string | null;
    };

export type SlackAssignmentPolicy = "off" | "immediate" | "after-investigation";

export interface SlackRoutingRule {
  readonly id: string;
  readonly name: string;
  readonly condition: SlackConditionGroup;
  readonly teamId: string | null;
  readonly projectId: string | null;
  readonly cycleId: string | null;
  readonly initialPlacement: SlackInitialPlacement;
  readonly investigation: SlackInvestigationPolicy;
  readonly assignment: SlackAssignmentPolicy;
}

export interface SlackWorkspaceWizardDraft {
  readonly integrationId: string | null;
  readonly integrationRevision: number | null;
  readonly ownerId: string | null;
  readonly workspace: SlackWorkspaceIdentity | null;
  readonly channelId: string | null;
  readonly channelName: string | null;
  readonly watchId: string | null;
  readonly watchRevision: number | null;
  readonly preferredEnvironmentId: string | null;
  readonly backupEnvironmentIds: readonly string[];
  readonly rules: readonly SlackRoutingRule[];
}

export type SlackReadinessState = "ready" | "warning" | "blocked";

export interface SlackWizardReadiness {
  readonly id: string;
  readonly label: string;
  readonly state: SlackReadinessState;
  readonly detail: string;
}

export type SlackActivationStageState = "pending" | "running" | "complete" | "warning" | "error";

export interface SlackActivationStage {
  readonly id: "configuration" | "routing" | "controller" | "health";
  readonly label: string;
  readonly state: SlackActivationStageState;
  readonly detail?: string | null;
}

export interface SlackWizardValidationContext {
  readonly ownerIds?: ReadonlySet<string>;
  readonly channelIds?: ReadonlySet<string>;
  readonly environmentIds?: ReadonlySet<string>;
  readonly teamIds?: ReadonlySet<string>;
  readonly projectIds?: ReadonlySet<string>;
  readonly statusIds?: ReadonlySet<string>;
  readonly cycleIds?: ReadonlySet<string>;
  readonly automationConfigured?: boolean;
  readonly readiness?: readonly SlackWizardReadiness[];
}

export interface SlackWizardNavigation {
  readonly step: SlackWorkspaceWizardStep;
  readonly error: string | null;
}

export function createEmptySlackWorkspaceDraft(): SlackWorkspaceWizardDraft {
  return {
    integrationId: null,
    integrationRevision: null,
    ownerId: null,
    workspace: null,
    channelId: null,
    channelName: null,
    watchId: null,
    watchRevision: null,
    preferredEnvironmentId: null,
    backupEnvironmentIds: [],
    rules: [],
  };
}

export function slackCatalogForEnvironment(
  catalog: SlackOwnerCatalog,
  environmentId: string | null,
): SlackOwnerCatalog {
  return {
    ...catalog,
    projects:
      environmentId === null
        ? []
        : catalog.projects.filter((project) => project.environmentIds.includes(environmentId)),
  };
}

export function createDefaultSlackRoutingRule(id: string): SlackRoutingRule {
  return {
    id,
    name: "New route",
    condition: {
      id: `${id}:condition`,
      type: "group",
      operator: "all",
      children: [],
    },
    teamId: null,
    projectId: null,
    cycleId: null,
    initialPlacement: { kind: "triage" },
    investigation: { kind: "off" },
    assignment: "off",
  };
}

export function defaultSlackActivationStages(): readonly SlackActivationStage[] {
  return [
    { id: "configuration", label: "Save workspace configuration", state: "pending" },
    { id: "routing", label: "Publish routing rules", state: "pending" },
    { id: "controller", label: "Confirm listener environments", state: "pending" },
    { id: "health", label: "Confirm the first healthy poll", state: "pending" },
  ];
}

export function normalizeSlackPrefix(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

export function normalizeSlackReaction(value: string): string {
  return value
    .trim()
    .replace(/^:+|:+$/g, "")
    .toLocaleLowerCase();
}

export function slackConditionNodeCount(node: SlackConditionNode): number {
  if (node.type !== "group") return 1;
  return 1 + node.children.reduce((total, child) => total + slackConditionNodeCount(child), 0);
}

export function slackConditionSummary(node: SlackConditionNode): string {
  switch (node.type) {
    case "prefix":
      return node.prefixes.length === 1
        ? `Starts with ${node.prefixes[0]}`
        : `${node.prefixes.length} prefixes`;
    case "reaction":
      return node.emoji.trim() ? `:${normalizeSlackReaction(node.emoji)}:` : "Slack reaction";
    case "botMention":
      return "Bot mention";
    case "everyMessage":
      return "Every message";
    case "group": {
      if (node.children.length === 0) return "No conditions";
      if (node.children.length === 1) return slackConditionSummary(node.children[0]!);
      return `${node.children.length} conditions (${node.operator === "all" ? "all" : "any"})`;
    }
  }
}

export function slackRuleUsesAutomation(rule: SlackRoutingRule): boolean {
  return rule.investigation.kind !== "off" || rule.assignment !== "off";
}

export function slackWizardVisibleSteps(
  rules: readonly SlackRoutingRule[],
): readonly SlackWorkspaceWizardStep[] {
  return rules.some(slackRuleUsesAutomation)
    ? AUTOMATED_SLACK_WORKSPACE_WIZARD_STEPS
    : BASIC_SLACK_WORKSPACE_WIZARD_STEPS;
}

export function nextSlackWizardStep(
  step: SlackWorkspaceWizardStep,
  rules: readonly SlackRoutingRule[],
): SlackWorkspaceWizardStep {
  if (step === 0) return 1;
  if (step === 1) return 2;
  if (step === 2) return rules.some(slackRuleUsesAutomation) ? 3 : 4;
  return 4;
}

export function slackRuleRequiresProject(rule: SlackRoutingRule): boolean {
  return slackRuleUsesAutomation(rule);
}

function slackConditionError(node: SlackConditionNode): string | null {
  switch (node.type) {
    case "prefix": {
      const prefixes = node.prefixes.map(normalizeSlackPrefix).filter(Boolean);
      if (prefixes.length === 0) return "Add at least one message prefix.";
      if (prefixes.length > SLACK_ROUTING_LIMITS.prefixesPerCondition) {
        return `Use no more than ${SLACK_ROUTING_LIMITS.prefixesPerCondition} prefixes in one condition.`;
      }
      if (prefixes.some((prefix) => prefix.length > SLACK_ROUTING_LIMITS.prefixCharacters)) {
        return `Keep each prefix under ${SLACK_ROUTING_LIMITS.prefixCharacters} characters.`;
      }
      return null;
    }
    case "reaction":
      return normalizeSlackReaction(node.emoji) ? null : "Enter a Slack reaction name.";
    case "botMention":
    case "everyMessage":
      return null;
    case "group": {
      if (node.children.length === 0) return "Add at least one condition.";
      for (const child of node.children) {
        const error = slackConditionError(child);
        if (error) return error;
      }
      return null;
    }
  }
}

export function slackRuleError(
  rule: SlackRoutingRule,
  context: SlackWizardValidationContext = {},
): string | null {
  if (!rule.name.trim()) return "Give this route a name.";
  if (slackConditionNodeCount(rule.condition) > SLACK_ROUTING_LIMITS.nodesPerRule) {
    return `Keep each route under ${SLACK_ROUTING_LIMITS.nodesPerRule} conditions and groups.`;
  }
  const conditionError = slackConditionError(rule.condition);
  if (conditionError) return conditionError;
  if (rule.teamId && context.teamIds && !context.teamIds.has(rule.teamId)) {
    return "Choose an available team.";
  }
  if (rule.projectId && context.projectIds && !context.projectIds.has(rule.projectId)) {
    return "Choose an available project.";
  }
  if (rule.cycleId && context.cycleIds && !context.cycleIds.has(rule.cycleId)) {
    return "Choose an available cycle.";
  }
  if (
    rule.initialPlacement.kind === "status" &&
    context.statusIds &&
    !context.statusIds.has(rule.initialPlacement.statusId)
  ) {
    return "Choose an available initial status.";
  }
  if (rule.investigation.kind === "status") {
    if (!rule.investigation.triggerStatusId) return "Choose when investigation should begin.";
    if (context.statusIds && !context.statusIds.has(rule.investigation.triggerStatusId)) {
      return "Choose an available investigation status.";
    }
  }
  if (
    rule.investigation.kind !== "off" &&
    rule.investigation.successStatusId &&
    context.statusIds &&
    !context.statusIds.has(rule.investigation.successStatusId)
  ) {
    return "Choose an available status for completed investigations.";
  }
  if (slackRuleRequiresProject(rule) && !rule.projectId) {
    return "Choose a project before enabling investigation or assignment.";
  }
  if (rule.assignment === "after-investigation" && rule.investigation.kind === "off") {
    return "Enable investigation before assigning after investigation.";
  }
  return null;
}

function serializedRoutingBytes(rules: readonly SlackRoutingRule[]): number {
  const serialized = JSON.stringify(rules);
  return typeof TextEncoder === "undefined"
    ? serialized.length
    : new TextEncoder().encode(serialized).length;
}

export function slackRoutingRulesError(
  rules: readonly SlackRoutingRule[],
  context: SlackWizardValidationContext = {},
): string | null {
  if (rules.length === 0) return "Add at least one route for this channel.";
  if (rules.length > SLACK_ROUTING_LIMITS.rulesPerChannel) {
    return `Use no more than ${SLACK_ROUTING_LIMITS.rulesPerChannel} routes for one channel.`;
  }
  const totalNodes = rules.reduce(
    (total, rule) => total + slackConditionNodeCount(rule.condition),
    0,
  );
  if (totalNodes > SLACK_ROUTING_LIMITS.nodesPerChannel) {
    return `Keep the channel under ${SLACK_ROUTING_LIMITS.nodesPerChannel} total conditions and groups.`;
  }
  if (serializedRoutingBytes(rules) > SLACK_ROUTING_LIMITS.serializedBytes) {
    return "This routing configuration is too large. Split it across fewer, simpler routes.";
  }
  for (let index = 0; index < rules.length; index += 1) {
    const error = slackRuleError(rules[index]!, context);
    if (error) return `Route ${index + 1}: ${error}`;
  }
  return null;
}

export function slackWizardStepError(
  step: SlackWorkspaceWizardStep,
  draft: SlackWorkspaceWizardDraft,
  context: SlackWizardValidationContext = {},
): string | null {
  if (step === 0) {
    if (!draft.ownerId) return "Choose who owns this Slack workspace.";
    if (context.ownerIds && !context.ownerIds.has(draft.ownerId)) {
      return "Choose an available owner.";
    }
    if (!draft.integrationId || !draft.workspace) return "Connect and validate a Slack workspace.";
    if (!draft.channelId) return "Choose the first Slack channel to watch.";
    if (context.channelIds && !context.channelIds.has(draft.channelId)) {
      return "Choose an available Slack channel.";
    }
    if (!draft.preferredEnvironmentId) {
      return "Choose the primary environment that will run this Slack listener.";
    }
    if (context.environmentIds && !context.environmentIds.has(draft.preferredEnvironmentId)) {
      return "Choose an available primary environment.";
    }
    if (
      draft.backupEnvironmentIds.some(
        (environmentId) =>
          environmentId === draft.preferredEnvironmentId ||
          (context.environmentIds !== undefined && !context.environmentIds.has(environmentId)),
      )
    ) {
      return "Choose a different available backup environment.";
    }
    return null;
  }
  const routingError = slackRoutingRulesError(draft.rules, context);
  if (routingError) return routingError;
  if (
    step === 3 &&
    draft.rules.some(slackRuleUsesAutomation) &&
    context.automationConfigured !== true
  ) {
    return "Save issue automation settings before continuing.";
  }
  if (step === 4 && context.readiness?.some((item) => item.state === "blocked")) {
    return "Resolve the blocked activation checks before activating.";
  }
  return null;
}

export function resolveSlackWizardNavigation(
  currentStep: SlackWorkspaceWizardStep,
  requestedStep: SlackWorkspaceWizardStep,
  draft: SlackWorkspaceWizardDraft,
  context: SlackWizardValidationContext = {},
): SlackWizardNavigation {
  if (requestedStep <= currentStep) return { step: requestedStep, error: null };
  for (let step = 0; step < requestedStep; step += 1) {
    const error = slackWizardStepError(step as SlackWorkspaceWizardStep, draft, context);
    if (error) return { step: step as SlackWorkspaceWizardStep, error };
  }
  return { step: requestedStep, error: null };
}

export function updateSlackConditionNode(
  root: SlackConditionNode,
  id: string,
  replacement: SlackConditionNode,
): SlackConditionNode {
  if (root.id === id) return replacement;
  if (root.type !== "group") return root;
  return {
    ...root,
    children: root.children.map((child) => updateSlackConditionNode(child, id, replacement)),
  };
}

export function removeSlackConditionNode(
  root: SlackConditionGroup,
  id: string,
): SlackConditionGroup {
  return {
    ...root,
    children: root.children
      .filter((child) => child.id !== id)
      .map((child) => (child.type === "group" ? removeSlackConditionNode(child, id) : child)),
  };
}

export function appendSlackConditionNode(
  root: SlackConditionGroup,
  parentId: string,
  child: SlackConditionNode,
): SlackConditionGroup {
  if (root.id === parentId) return { ...root, children: [...root.children, child] };
  return {
    ...root,
    children: root.children.map((node) =>
      node.type === "group" ? appendSlackConditionNode(node, parentId, child) : node,
    ),
  };
}
