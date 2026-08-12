import type {
  Issue,
  IssueAutomationAuditRule,
  IssueAutomationRoutingRule,
  IssueAutomationSettings,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { extractLastJsonObject } from "./enrichment.ts";

export interface IssueAutomationClassification {
  readonly routingRuleId: string | null;
  readonly auditRuleIds: ReadonlyArray<string>;
  readonly rationale: string;
}

export interface IssueAutomationAuditResult {
  readonly verdict: "pass" | "changes_requested";
  readonly summary: string;
  readonly findings: ReadonlyArray<string>;
}

export type IssueAutomationAuditOutcome =
  | { readonly kind: "pending" }
  | { readonly kind: "passed" }
  | { readonly kind: "changes_requested"; readonly findings: ReadonlyArray<string> };

const AutomationClassificationResponse = Schema.fromJsonString(
  Schema.Struct({
    routingRuleId: Schema.NullOr(Schema.String),
    auditRuleIds: Schema.Array(Schema.String),
    rationale: Schema.String,
  }),
);
const decodeAutomationClassificationResponse = Schema.decodeUnknownOption(
  AutomationClassificationResponse,
);

const AutomationAuditResponse = Schema.fromJsonString(
  Schema.Struct({
    verdict: Schema.Literals(["pass", "changes_requested"]),
    summary: Schema.String,
    findings: Schema.Array(Schema.String),
  }),
);
const decodeAutomationAuditResponse = Schema.decodeUnknownOption(AutomationAuditResponse);

const issueText = (issue: Issue) =>
  [`Issue ${issue.key}: ${issue.title}`, issue.description.trim()].filter(Boolean).join("\n\n");

export function shouldTriggerIssueAutomationAudit(input: {
  readonly issue: Pick<Issue, "automationAssignment" | "statusId">;
  readonly previousStatusId: string | null | undefined;
  readonly reviewStatusId: string | null;
}): boolean {
  return (
    input.reviewStatusId !== null &&
    (input.issue.automationAssignment ?? null) !== null &&
    input.issue.statusId === input.reviewStatusId &&
    input.previousStatusId !== input.issue.statusId
  );
}

export function resolveIssueAutomationAuditOutcome(
  runs: ReadonlyArray<{
    readonly state: "running" | "done" | "failed";
    readonly verdict: "pass" | "changes_requested" | null;
    readonly findings: ReadonlyArray<string>;
  }>,
): IssueAutomationAuditOutcome {
  if (runs.length === 0 || runs.some((run) => run.state !== "done")) {
    return { kind: "pending" };
  }
  const changes = runs.filter((run) => run.verdict === "changes_requested");
  return changes.length === 0
    ? { kind: "passed" }
    : { kind: "changes_requested", findings: changes.flatMap((run) => run.findings) };
}

export function buildIssueAutomationClassificationPrompt(input: {
  readonly issue: Issue;
  readonly routingRules: ReadonlyArray<IssueAutomationRoutingRule>;
  readonly auditRules: ReadonlyArray<IssueAutomationAuditRule>;
}): string {
  const routing = input.routingRules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    condition: rule.condition,
  }));
  const audits = input.auditRules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    condition: rule.condition,
  }));
  return `Classify this issue against the configured automation rules.

${issueText(input.issue)}

Routing rules (choose the first matching rule, or null):
${JSON.stringify(routing, null, 2)}

Audit rules (choose every matching rule):
${JSON.stringify(audits, null, 2)}

Return one JSON object and nothing else:
{"routingRuleId":"rule id or null","auditRuleIds":["matching audit rule ids"],"rationale":"one short sentence"}`;
}

export function normalizeIssueAutomationClassification(
  text: string,
  settings: IssueAutomationSettings,
): IssueAutomationClassification | null {
  const json = extractLastJsonObject(text);
  if (json === null) return null;
  const response = Option.getOrNull(decodeAutomationClassificationResponse(json));
  if (response === null) return null;
  const knownRouting = new Set(settings.routingRules.map((rule) => rule.id as string));
  const knownAudits = new Set(settings.auditRules.map((rule) => rule.id as string));
  const routingRuleId =
    response.routingRuleId !== null && knownRouting.has(response.routingRuleId)
      ? response.routingRuleId
      : null;
  const auditRuleIds = [...new Set(response.auditRuleIds.filter((id) => knownAudits.has(id)))];
  const rationale =
    response.rationale.trim().length > 0
      ? response.rationale.trim().slice(0, 1_000)
      : "Matched the configured automation rules.";
  return { routingRuleId, auditRuleIds, rationale };
}

export function buildIssueAutomationAuditPrompt(input: {
  readonly issue: Issue;
  readonly rule: IssueAutomationAuditRule;
  readonly remediationCycle: number;
}): string {
  return `Audit the completed work for this issue in the current repository. Read the actual diff,
tests, and relevant source. Do not edit anything.

${issueText(input.issue)}

Audit policy: ${input.rule.name}
Apply when: ${input.rule.condition}
Review cycle: ${input.remediationCycle}

Return one JSON object and nothing else:
{"verdict":"pass or changes_requested","summary":"short markdown summary","findings":["specific actionable finding"]}

Use changes_requested only for a concrete defect, regression, missing requirement, or failed
verification. Do not request stylistic churn. A pass may still mention non-blocking observations in
the summary.`;
}

export function normalizeIssueAutomationAuditResult(
  text: string,
): IssueAutomationAuditResult | null {
  const json = extractLastJsonObject(text);
  if (json === null) return null;
  const response = Option.getOrNull(decodeAutomationAuditResponse(json));
  if (response === null) return null;
  const findings = response.findings
    .map((finding) => finding.trim())
    .filter(Boolean)
    .slice(0, 50);
  if (response.verdict === "changes_requested" && findings.length === 0) return null;
  return {
    verdict: response.verdict,
    summary: response.summary.trim().slice(0, 12_000),
    findings,
  };
}

export function issueAutomationAuditComment(input: {
  readonly ruleName: string;
  readonly modelLabel: string;
  readonly result: IssueAutomationAuditResult;
}): string {
  const heading = input.result.verdict === "pass" ? "Audit passed" : "Audit requested changes";
  const findings =
    input.result.findings.length === 0
      ? ""
      : `\n\n${input.result.findings.map((finding) => `- ${finding}`).join("\n")}`;
  return `### ${heading} — ${input.ruleName}\n\n${input.result.summary}${findings}\n\n_Model: ${input.modelLabel}_`;
}
