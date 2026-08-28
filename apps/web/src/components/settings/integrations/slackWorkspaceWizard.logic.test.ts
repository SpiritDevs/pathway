import { describe, expect, it } from "vite-plus/test";

import {
  appendSlackConditionNode,
  createDefaultSlackRoutingRule,
  createEmptySlackWorkspaceDraft,
  normalizeSlackPrefix,
  normalizeSlackReaction,
  nextSlackWizardStep,
  removeSlackConditionNode,
  resolveSlackWizardNavigation,
  SLACK_ROUTING_LIMITS,
  slackCatalogForEnvironment,
  slackConditionNodeCount,
  slackRoutingRulesError,
  slackRuleError,
  slackWizardStepError,
  slackWizardVisibleSteps,
  updateSlackConditionNode,
  type SlackConditionGroup,
  type SlackRoutingRule,
  type SlackWorkspaceWizardDraft,
} from "./slackWorkspaceWizard.logic";

const connectedDraft = (rules: readonly SlackRoutingRule[]): SlackWorkspaceWizardDraft => ({
  integrationId: "integration-1",
  integrationRevision: 1,
  ownerId: "company-1",
  workspace: { id: "workspace-1", name: "Spirit Developers", domain: "spiritdevs" },
  channelId: "channel-1",
  channelName: "issues",
  watchId: "watch-1",
  watchRevision: 1,
  preferredEnvironmentId: "environment-1",
  backupEnvironmentIds: [],
  rules,
});

const everyMessageRule = (): SlackRoutingRule => ({
  ...createDefaultSlackRoutingRule("rule-1"),
  name: "Everything else",
  condition: {
    id: "condition-root",
    type: "group",
    operator: "all",
    children: [{ id: "condition-every", type: "everyMessage" }],
  },
});

describe("Slack workspace wizard navigation", () => {
  it("returns users to the first incomplete step when they jump ahead", () => {
    expect(resolveSlackWizardNavigation(0, 4, createEmptySlackWorkspaceDraft())).toEqual({
      step: 0,
      error: "Choose who owns this Slack workspace.",
    });

    expect(resolveSlackWizardNavigation(4, 0, connectedDraft([everyMessageRule()]))).toEqual({
      step: 0,
      error: null,
    });
  });

  it("requires a primary listener and rejects an invalid backup", () => {
    const draft = connectedDraft([everyMessageRule()]);
    expect(
      slackWizardStepError(
        0,
        { ...draft, preferredEnvironmentId: null },
        {
          environmentIds: new Set(["environment-1", "environment-2"]),
        },
      ),
    ).toBe("Choose the primary environment that will run this Slack listener.");
    expect(
      slackWizardStepError(
        0,
        { ...draft, backupEnvironmentIds: ["environment-1"] },
        { environmentIds: new Set(["environment-1", "environment-2"]) },
      ),
    ).toBe("Choose a different available backup environment.");
  });

  it("skips issue automation setup when no route uses it", () => {
    expect(slackWizardVisibleSteps([everyMessageRule()])).toEqual([0, 1, 2, 4]);
    expect(nextSlackWizardStep(2, [everyMessageRule()])).toBe(4);
    expect(resolveSlackWizardNavigation(0, 4, connectedDraft([everyMessageRule()]))).toEqual({
      step: 4,
      error: null,
    });
  });

  it("requires issue automation settings for routes that investigate or assign", () => {
    const automatedRule: SlackRoutingRule = {
      ...everyMessageRule(),
      projectId: "project-1",
      investigation: { kind: "immediate", successStatusId: null },
    };
    const draft = connectedDraft([automatedRule]);

    expect(slackWizardVisibleSteps(draft.rules)).toEqual([0, 1, 2, 3, 4]);
    expect(nextSlackWizardStep(2, draft.rules)).toBe(3);
    expect(resolveSlackWizardNavigation(0, 4, draft)).toEqual({
      step: 3,
      error: "Save issue automation settings before continuing.",
    });
    expect(resolveSlackWizardNavigation(0, 4, draft, { automationConfigured: true })).toEqual({
      step: 4,
      error: null,
    });
  });

  it("blocks activation when a readiness check is blocked", () => {
    expect(
      slackWizardStepError(4, connectedDraft([everyMessageRule()]), {
        readiness: [
          { id: "controller", label: "Controller", state: "blocked", detail: "None online" },
        ],
      }),
    ).toBe("Resolve the blocked activation checks before activating.");
  });
});

describe("Slack environment project catalog", () => {
  const catalog = {
    environments: [
      { id: "environment-1", name: "Primary" },
      { id: "environment-2", name: "Remote" },
    ],
    teams: [],
    statuses: [],
    projects: [
      { id: "project-1", name: "Primary only", environmentIds: ["environment-1"] },
      { id: "project-2", name: "Remote only", environmentIds: ["environment-2"] },
      { id: "project-3", name: "Shared", environmentIds: ["environment-1", "environment-2"] },
    ],
    cycles: [],
  };

  it("shows only projects checked out on the primary listener environment", () => {
    expect(
      slackCatalogForEnvironment(catalog, "environment-1").projects.map((project) => project.id),
    ).toEqual(["project-1", "project-3"]);
    expect(slackCatalogForEnvironment(catalog, null).projects).toEqual([]);
  });
});

describe("Slack routing validation", () => {
  it("requires a project for investigation and assignment", () => {
    const investigationRule: SlackRoutingRule = {
      ...everyMessageRule(),
      investigation: { kind: "immediate", successStatusId: null },
    };
    expect(slackRuleError(investigationRule)).toBe(
      "Choose a project before enabling investigation or assignment.",
    );

    const assignmentRule: SlackRoutingRule = {
      ...everyMessageRule(),
      assignment: "after-investigation",
    };
    expect(slackRuleError(assignmentRule)).toBe(
      "Choose a project before enabling investigation or assignment.",
    );
  });

  it("requires investigation before the after-investigation assignment timing", () => {
    const rule: SlackRoutingRule = {
      ...everyMessageRule(),
      projectId: "project-1",
      assignment: "after-investigation",
    };
    expect(slackRuleError(rule)).toBe("Enable investigation before assigning after investigation.");
  });

  it("enforces route and nested condition bounds", () => {
    const tooManyRules = Array.from(
      { length: SLACK_ROUTING_LIMITS.rulesPerChannel + 1 },
      (_, index) => ({ ...everyMessageRule(), id: `rule-${index}` }),
    );
    expect(slackRoutingRulesError(tooManyRules)).toBe(
      `Use no more than ${SLACK_ROUTING_LIMITS.rulesPerChannel} routes for one channel.`,
    );

    const condition: SlackConditionGroup = {
      id: "root",
      type: "group",
      operator: "any",
      children: [
        { id: "one", type: "botMention" },
        {
          id: "nested",
          type: "group",
          operator: "all",
          children: [{ id: "two", type: "reaction", emoji: "ticket" }],
        },
      ],
    };
    expect(slackConditionNodeCount(condition)).toBe(4);
  });

  it("normalizes prefixes and Slack emoji names before validation", () => {
    expect(normalizeSlackPrefix("  NEW   ISSUE: ")).toBe("new issue:");
    expect(normalizeSlackReaction(" :Ticket: ")).toBe("ticket");
  });
});

describe("Slack condition tree edits", () => {
  const root: SlackConditionGroup = {
    id: "root",
    type: "group",
    operator: "all",
    children: [{ id: "mention", type: "botMention" }],
  };

  it("appends, updates, and removes nested nodes without mutating the input", () => {
    const appended = appendSlackConditionNode(root, "root", {
      id: "reaction",
      type: "reaction",
      emoji: "ticket",
    });
    const updated = updateSlackConditionNode(appended, "reaction", {
      id: "reaction",
      type: "reaction",
      emoji: "support",
    }) as SlackConditionGroup;
    const removed = removeSlackConditionNode(updated, "mention");

    expect(root.children).toHaveLength(1);
    expect(updated.children[1]).toEqual({ id: "reaction", type: "reaction", emoji: "support" });
    expect(removed.children).toEqual([{ id: "reaction", type: "reaction", emoji: "support" }]);
  });
});
