import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { EnvironmentId } from "./baseSchemas.ts";
import {
  SLACK_CONTROLLER_MAX_BACKUPS,
  SLACK_ROUTING_MAX_NODES_PER_RULE,
  SLACK_ROUTING_MAX_PREFIX_CHARS,
  SLACK_ROUTING_MAX_PREFIXES_PER_LEAF,
  SLACK_ROUTING_MAX_RULES_PER_CHANNEL,
  SLACK_ROUTING_MAX_SERIALIZED_BYTES,
  CompanySlackChannelWatchDefinition,
  CompanySlackRoutingConfigurationV2,
  CompanySlackRoutingRule,
  EnvironmentProviderCapabilitySnapshot,
  IssueAutomationJobResult,
  SlackControllerPool,
  SlackIntegration,
} from "./integrations.ts";
import { Issue } from "./issues.ts";

const decodePool = Schema.decodeUnknownSync(SlackControllerPool);
const decodeRoutingRule = Schema.decodeUnknownSync(CompanySlackRoutingRule);
const decodeRoutingConfiguration = Schema.decodeUnknownSync(CompanySlackRoutingConfigurationV2);
const decodeSlackIntegration = Schema.decodeUnknownSync(SlackIntegration);
const decodeIssue = Schema.decodeUnknownSync(Issue);
const decodeAutomationJobResult = Schema.decodeUnknownSync(IssueAutomationJobResult);
const decodeChannelWatchDefinition = Schema.decodeUnknownSync(CompanySlackChannelWatchDefinition);
const decodeProviderCapabilitySnapshot = Schema.decodeUnknownSync(
  EnvironmentProviderCapabilitySnapshot,
);

const routingRule = (id: string, condition: unknown = { kind: "every-message" }) => ({
  id,
  name: `Rule ${id}`,
  condition,
  teamId: null,
  cloudProjectId: null,
  cycleId: null,
  initialStatusId: null,
  investigation: {
    timing: "off",
    triggerStatusId: null,
    successStatusId: null,
  },
  assignmentTiming: "off",
});

describe("company integration contracts", () => {
  it("bounds and de-duplicates the ordered controller backups", () => {
    expect(() =>
      decodePool({
        preferredEnvironmentId: EnvironmentId.make("preferred"),
        backupEnvironmentIds: Array.from(
          { length: SLACK_CONTROLLER_MAX_BACKUPS + 1 },
          (_, index) => `backup-${index}`,
        ),
      }),
    ).toThrow();
    expect(() =>
      decodePool({
        preferredEnvironmentId: "preferred",
        backupEnvironmentIds: ["backup", "backup"],
      }),
    ).toThrow();
    expect(() =>
      decodePool({ preferredEnvironmentId: "preferred", backupEnvironmentIds: ["preferred"] }),
    ).toThrow();
  });

  it("keeps credentials out of public Slack integration metadata", () => {
    const decoded = decodeSlackIntegration({
      id: "integration-1",
      companyId: "company-1",
      workspaceId: "T1",
      workspaceName: "Acme",
      workspaceDomain: "acme",
      botUserId: "U1",
      botId: "B1",
      state: "active",
      activatedAt: 1,
      credentialPresent: true,
      controllerPool: { preferredEnvironmentId: "environment-1", backupEnvironmentIds: [] },
      configurationRevision: 1,
      health: {
        controllerEnvironmentId: "environment-1",
        lastPollAt: 1,
        currentError: null,
        blockedReason: null,
        watchCount: 1,
      },
      createdAt: 1,
      updatedAt: 1,
      token: "xoxb-secret",
    });
    expect("token" in decoded).toBe(false);
  });

  it("decodes historical Slack sources without company integration identity", () => {
    const decoded = decodeIssue({
      id: "issue-1",
      key: "PAT-1",
      title: "Legacy Slack issue",
      description: "",
      statusId: "status-1",
      priority: "none",
      assignee: null,
      projectId: null,
      milestoneId: null,
      cycleId: null,
      parentId: null,
      sortOrder: "a",
      labelIds: [],
      dueDate: null,
      triage: true,
      slackSource: {
        issueId: "issue-1",
        channelId: "C1",
        messageTs: "1723459200.000100",
        permalink: null,
        authorName: null,
      },
      teamIds: [],
      workflowOwner: { kind: "company" },
      workModelSelection: null,
      automationAssignment: null,
      pullRequest: null,
      createdAt: "2026-08-18T00:00:00.000Z",
      updatedAt: "2026-08-18T00:00:00.000Z",
      deletedAt: null,
    });
    expect(decoded.slackSource?.integrationId).toBeUndefined();
    expect(decoded.slackSource?.workspaceId).toBeUndefined();
  });

  it("decodes typed durable automation results", () => {
    const decoded = decodeAutomationJobResult({
      kind: "audit",
      outcome: "changes-requested",
      summary: "Two findings need work.",
      findings: ["Add a lease fence test", "Reconcile the outbound delivery"],
    });
    expect(decoded.kind).toBe("audit");
  });

  it("decodes ordered V2 rules with nested conditions and nullable draft destinations", () => {
    const decoded = decodeRoutingConfiguration({
      configurationVersion: 2,
      rules: [
        {
          ...routingRule("triage"),
          condition: {
            kind: "all",
            conditions: [
              { kind: "bot-mention" },
              {
                kind: "any",
                conditions: [
                  { kind: "text-prefix", prefixes: ["bug:", "urgent bug:"] },
                  { kind: "reaction", emoji: "ticket" },
                ],
              },
            ],
          },
          investigation: {
            timing: "on-status",
            triggerStatusId: null,
            successStatusId: null,
          },
          assignmentTiming: "after-investigation",
        },
        routingRule("fallback"),
      ],
    });

    expect(decoded.rules.map((rule) => rule.id)).toEqual(["triage", "fallback"]);
    expect(decoded.rules[0]?.teamId).toBeNull();
    expect(decoded.rules[0]?.investigation.timing).toBe("on-status");
  });

  it("bounds prefixes and condition nodes at the schema boundary", () => {
    expect(() =>
      decodeRoutingRule(
        routingRule("prefix-count", {
          kind: "text-prefix",
          prefixes: Array.from(
            { length: SLACK_ROUTING_MAX_PREFIXES_PER_LEAF + 1 },
            (_, index) => `prefix-${index}`,
          ),
        }),
      ),
    ).toThrow();
    expect(() =>
      decodeRoutingRule(
        routingRule("prefix-length", {
          kind: "text-prefix",
          prefixes: ["x".repeat(SLACK_ROUTING_MAX_PREFIX_CHARS + 1)],
        }),
      ),
    ).toThrow();
    expect(() =>
      decodeRoutingRule(
        routingRule("node-count", {
          kind: "all",
          conditions: Array.from({ length: SLACK_ROUTING_MAX_NODES_PER_RULE }, () => ({
            kind: "every-message",
          })),
        }),
      ),
    ).toThrow();
  });

  it("bounds V2 rule count, aggregate nodes, and serialized configuration size", () => {
    expect(() =>
      decodeRoutingConfiguration({
        configurationVersion: 2,
        rules: Array.from({ length: SLACK_ROUTING_MAX_RULES_PER_CHANNEL + 1 }, (_, index) =>
          routingRule(`rule-${index}`),
        ),
      }),
    ).toThrow();
    expect(() =>
      decodeRoutingConfiguration({
        configurationVersion: 2,
        rules: Array.from({ length: 6 }, (_, index) =>
          routingRule(`nodes-${index}`, {
            kind: "all",
            conditions: Array.from({ length: 41 }, () => ({ kind: "every-message" })),
          }),
        ),
      }),
    ).toThrow();
    expect(() =>
      decodeRoutingConfiguration({
        configurationVersion: 2,
        rules: [
          {
            ...routingRule("oversized"),
            name: "x".repeat(SLACK_ROUTING_MAX_SERIALIZED_BYTES),
          },
        ],
      }),
    ).toThrow();
  });

  it("preserves V1 watch and capability snapshot decoding", () => {
    const watch = decodeChannelWatchDefinition({
      id: "watch-1",
      companyId: "company-1",
      integrationId: "integration-1",
      channelId: "C1",
      channelName: "support",
      cloudProjectId: null,
      cycleId: null,
      autoInvestigate: false,
      autoAssign: false,
      trigger: { reactionRoutes: [], everyMessage: true, botMention: false },
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    });
    const capabilities = decodeProviderCapabilitySnapshot({
      companyId: "company-1",
      environmentId: "environment-1",
      revision: 1,
      supportsSlackCoordination: true,
      supportsAutomationJobs: true,
      providers: [],
      publishedAt: 1,
    });

    expect("configurationVersion" in watch).toBe(false);
    expect(capabilities.slackProtocolVersion).toBeUndefined();
  });
});
