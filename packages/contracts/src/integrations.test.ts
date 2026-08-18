import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { EnvironmentId } from "./baseSchemas.ts";
import {
  SLACK_CONTROLLER_MAX_BACKUPS,
  IssueAutomationJobResult,
  SlackControllerPool,
  SlackIntegration,
} from "./integrations.ts";
import { Issue } from "./issues.ts";

const decodePool = Schema.decodeUnknownSync(SlackControllerPool);

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
    const decoded = Schema.decodeUnknownSync(SlackIntegration)({
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
    const decoded = Schema.decodeUnknownSync(Issue)({
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
    const decoded = Schema.decodeUnknownSync(IssueAutomationJobResult)({
      kind: "audit",
      outcome: "changes-requested",
      summary: "Two findings need work.",
      findings: ["Add a lease fence test", "Reconcile the outbound delivery"],
    });
    expect(decoded.kind).toBe("audit");
  });
});
