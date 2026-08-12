import { describe, expect, it } from "@effect/vitest";
import {
  IssueId,
  IssueKey,
  IssueStatusId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import type { Issue, IssueAutomationSettings } from "@t3tools/contracts";

import {
  buildIssueAutomationAuditPrompt,
  buildIssueAutomationClassificationPrompt,
  normalizeIssueAutomationAuditResult,
  normalizeIssueAutomationClassification,
  resolveIssueAutomationAuditOutcome,
  shouldTriggerIssueAutomationAudit,
} from "./automation.ts";

const selection = (model: string) => ({
  instanceId: ProviderInstanceId.make("codex"),
  model,
});

const issue: Issue = {
  id: IssueId.make("issue-1"),
  key: IssueKey.make("ISS-1"),
  title: "Fix the responsive navigation",
  description: "The mobile menu overlaps the account switcher.",
  statusId: IssueStatusId.make("todo"),
  priority: "high",
  assignee: null,
  workModelSelection: null,
  automationAssignment: null,
  projectId: ProjectId.make("project-1"),
  milestoneId: null,
  cycleId: null,
  parentId: null,
  sortOrder: "a0",
  labelIds: [],
  dueDate: null,
  triage: true,
  slackSource: null,
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
  deletedAt: null,
};

const settings: IssueAutomationSettings = {
  schemaVersion: 1,
  routingModelSelection: selection("router"),
  routingRules: [
    { id: "ui", name: "UI", condition: "Frontend work", modelSelection: selection("opus") },
    {
      id: "backend",
      name: "Backend",
      condition: "Server work",
      modelSelection: selection("sol"),
    },
  ],
  fallbackModelSelection: selection("luna"),
  auditRules: [
    {
      id: "implementation",
      name: "Implementation",
      condition: "All code changes",
      auditors: [
        { id: "fable", modelSelection: selection("fable") },
        { id: "sol", modelSelection: selection("sol") },
      ],
    },
  ],
  statusTransitions: {
    workStartedStatusId: "progress",
    workFinishedStatusId: "review",
    auditPassedStatusId: "done",
    auditChangesRequestedStatusId: "progress",
  },
  maxRemediationCycles: 3,
};

describe("issue automation prompts", () => {
  it("only exposes rule ids, descriptions, and the issue to the classifier", () => {
    const prompt = buildIssueAutomationClassificationPrompt({
      issue,
      routingRules: settings.routingRules,
      auditRules: settings.auditRules,
    });
    expect(prompt).toContain("Fix the responsive navigation");
    expect(prompt).toContain('"id": "ui"');
    expect(prompt).not.toContain('"model": "opus"');
  });

  it("drops invented routing and audit ids", () => {
    expect(
      normalizeIssueAutomationClassification(
        '{"routingRuleId":"invented","auditRuleIds":["implementation","invented"],"rationale":"UI issue"}',
        settings,
      ),
    ).toEqual({ routingRuleId: null, auditRuleIds: ["implementation"], rationale: "UI issue" });
  });

  it("asks an auditor to inspect real repository state without editing it", () => {
    const prompt = buildIssueAutomationAuditPrompt({
      issue,
      rule: settings.auditRules[0]!,
      remediationCycle: 2,
    });
    expect(prompt).toContain("Read the actual diff");
    expect(prompt).toContain("Do not edit anything");
    expect(prompt).toContain("Review cycle: 2");
  });

  it("accepts a structured blocking audit and rejects unknown verdicts", () => {
    expect(
      normalizeIssueAutomationAuditResult(
        '{"verdict":"changes_requested","summary":"One defect","findings":["Missing test"]}',
      ),
    ).toEqual({ verdict: "changes_requested", summary: "One defect", findings: ["Missing test"] });
    expect(
      normalizeIssueAutomationAuditResult('{"verdict":"maybe","summary":"Unsure","findings":[]}'),
    ).toBeNull();
  });

  it("starts review only on an opted-in issue entering the configured custom status", () => {
    expect(
      shouldTriggerIssueAutomationAudit({
        issue: {
          statusId: IssueStatusId.make("custom-review"),
          automationAssignment: {
            routingRuleId: "ui",
            auditRuleIds: ["implementation"],
            rationale: "UI work",
            assignedAt: "2026-08-13T00:00:00.000Z",
          },
        },
        previousStatusId: "custom-building",
        reviewStatusId: "custom-review",
      }),
    ).toBe(true);
    expect(
      shouldTriggerIssueAutomationAudit({
        issue: { statusId: IssueStatusId.make("custom-review"), automationAssignment: null },
        previousStatusId: "custom-building",
        reviewStatusId: "custom-review",
      }),
    ).toBe(false);
  });

  it("waits for every auditor and combines all independent blocking findings", () => {
    expect(resolveIssueAutomationAuditOutcome([])).toEqual({ kind: "pending" });
    expect(
      resolveIssueAutomationAuditOutcome([
        { state: "done", verdict: "pass", findings: [] },
        { state: "running", verdict: null, findings: [] },
      ]),
    ).toEqual({ kind: "pending" });
    expect(
      resolveIssueAutomationAuditOutcome([
        { state: "done", verdict: "changes_requested", findings: ["Broken UI"] },
        { state: "done", verdict: "changes_requested", findings: ["Missing server test"] },
      ]),
    ).toEqual({
      kind: "changes_requested",
      findings: ["Broken UI", "Missing server test"],
    });
    expect(
      resolveIssueAutomationAuditOutcome([
        { state: "done", verdict: "pass", findings: [] },
        { state: "done", verdict: "pass", findings: [] },
      ]),
    ).toEqual({ kind: "passed" });
  });
});
