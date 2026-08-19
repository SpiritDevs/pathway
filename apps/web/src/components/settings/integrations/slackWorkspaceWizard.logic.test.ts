import { describe, expect, it } from "vite-plus/test";

import {
  appendSlackConditionNode,
  createDefaultSlackRoutingRule,
  createEmptySlackWorkspaceDraft,
  normalizeSlackPrefix,
  normalizeSlackReaction,
  removeSlackConditionNode,
  resolveSlackWizardNavigation,
  SLACK_ROUTING_LIMITS,
  slackConditionNodeCount,
  slackRoutingRulesError,
  slackRuleError,
  slackWizardStepError,
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
    expect(resolveSlackWizardNavigation(0, 2, createEmptySlackWorkspaceDraft())).toEqual({
      step: 0,
      error: "Choose who owns this Slack workspace.",
    });

    expect(resolveSlackWizardNavigation(2, 0, connectedDraft([everyMessageRule()]))).toEqual({
      step: 0,
      error: null,
    });
  });

  it("allows a connected workspace with a channel and valid route to reach activation", () => {
    expect(resolveSlackWizardNavigation(0, 2, connectedDraft([everyMessageRule()]))).toEqual({
      step: 2,
      error: null,
    });
  });

  it("blocks activation when a readiness check is blocked", () => {
    expect(
      slackWizardStepError(2, connectedDraft([everyMessageRule()]), {
        readiness: [
          { id: "controller", label: "Controller", state: "blocked", detail: "None online" },
        ],
      }),
    ).toBe("Resolve the blocked activation checks before activating.");
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
