/**
 * Connects issue intake and workflow state to durable orchestration without putting agent effects
 * inside the tracker aggregate. The tracker remains plain state; this coordinator observes its
 * replay-safe stream and writes ordinary, attributed tracker commands back.
 */
import {
  CommandId,
  type Issue,
  type IssueActor,
  type IssueAutomationAuditRule,
  type IssueAutomationSettings,
  type IssuesStreamEvent,
  type IssueStatusId,
  type IssueThreadLink,
  MessageId,
  type ModelSelection,
  type SlackChannelWatch,
  type ThreadId,
} from "@spiritdevs/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";

import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { IssueAutomationAuditRepository } from "../persistence/Services/IssueAutomationAudits.ts";
import { IssueThreadLinkRepository } from "../persistence/Services/IssueThreadLinks.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { IssueTrackerService } from "./IssueTrackerService.ts";
import {
  isCompanyAutomationActive,
  shouldDeferLocalIssueAutomation,
} from "../cloud/companyIntegrationActivation.ts";
import {
  buildIssueAutomationAuditPrompt,
  buildIssueAutomationClassificationPrompt,
  buildIssueAutomationRemediationPrompt,
  issueAutomationAuditComment,
  normalizeIssueAutomationAuditResult,
  normalizeIssueAutomationClassification,
  resolveIssueAutomationAuditOutcome,
  resolveIssueAutomationReviewWorkers,
  resolveIssueAutomationStatuses,
  shouldTriggerIssueAutomationAudit,
} from "./automation.ts";

const AUTOMATION_ACTOR: IssueActor = { kind: "system", source: "automation" };

const modelLabel = (selection: ModelSelection) => `${selection.instanceId} / ${selection.model}`;

const withLoggedFailure = <E, R>(label: string, effect: Effect.Effect<void, E, R>) =>
  effect.pipe(Effect.catchCause((cause) => Effect.logWarning(label, { cause })));

/**
 * Everything the coordinator is except the loop that feeds it: the state, the boot seeding, and
 * the handler for one tracker event. {@link make} forks the loop over this; a test drives the
 * returned handler directly, so an assertion about what an event caused never has to race a fiber.
 */
export const makeHandler = Effect.gen(function* () {
  const tracker = yield* IssueTrackerService;
  const settingsService = yield* ServerSettingsService;
  const textGeneration = yield* TextGeneration;
  const providers = yield* ProviderInstanceRegistry;
  const projects = yield* ProjectionProjectRepository;
  const threadLinks = yield* IssueThreadLinkRepository;
  const threads = yield* ThreadManagementService;
  const audits = yield* IssueAutomationAuditRepository;
  const crypto = yield* Crypto.Crypto;

  yield* audits.releaseInterruptedClaims();

  const issues = yield* Ref.make(new Map<string, Issue>());
  const watches = yield* Ref.make(new Map<string, SlackChannelWatch>());
  const routing = yield* Ref.make(new Set<string>());
  const auditing = yield* Ref.make(new Set<string>());

  /**
   * The start-work link this coordinator has already acted on, per issue. The tracker republishes
   * an issue's whole thread list whenever any link on it changes, so reacting to a list that
   * *contains* a start-work link reapplies the work status and the assignee every time something
   * else touches the issue — a chat message naming the key is enough to drag a card the user moved
   * to In Review back to In Progress. Seeded from what is stored so a restart's replay is not an
   * appearance either.
   */
  const startWorkLinks = yield* Ref.make(new Map<string, string>());
  const startWorkMark = (link: IssueThreadLink) => `${link.threadId}\u0000${link.createdAt}`;
  yield* threadLinks.listAll().pipe(
    Effect.flatMap((links) => {
      // `listAll` is ordered by issue then creation, so the last start-work row per issue is the
      // same one the handler's `findLast` picks off a published list.
      const seeded = new Map<string, string>();
      for (const link of links) {
        if (link.origin === "start-work") seeded.set(link.issueId, startWorkMark(link));
      }
      return Ref.set(startWorkLinks, seeded);
    }),
  );

  const currentSettings = settingsService.getSettings.pipe(
    Effect.map((settings) => settings.issueAutomation),
  );

  const updateStatus = (issue: Issue, statusId: string | null) =>
    statusId === null || issue.statusId === statusId
      ? Effect.void
      : tracker
          .update(
            { issueId: issue.id, patch: { statusId: statusId as IssueStatusId } },
            AUTOMATION_ACTOR,
          )
          .pipe(Effect.asVoid);

  const projectWorkspace = (issue: Issue) =>
    issue.projectId === null
      ? Effect.succeed(null)
      : projects.getById({ projectId: issue.projectId }).pipe(
          Effect.map(Option.getOrNull),
          Effect.map((project) => project?.workspaceRoot ?? null),
        );

  const classify = (issue: Issue, automation: IssueAutomationSettings, cwd: string) =>
    automation.routingRules.length === 0 && automation.auditRules.length === 0
      ? Effect.succeed({
          routingRuleId: null,
          auditRuleIds: [],
          rationale: "Used the fallback model.",
        })
      : textGeneration
          .investigate({
            cwd,
            prompt: buildIssueAutomationClassificationPrompt({
              issue,
              routingRules: automation.routingRules,
              auditRules: automation.auditRules,
            }),
            modelSelection: automation.routingModelSelection,
          })
          .pipe(
            Effect.map(
              (generated) =>
                normalizeIssueAutomationClassification(generated.text, automation) ?? {
                  routingRuleId: null,
                  auditRuleIds: [],
                  rationale: "The router returned no matching rule, so the fallback was used.",
                },
            ),
          );

  const routeIssue = (issue: Issue) =>
    Effect.gen(function* () {
      if (issue.slackSource?.integrationId !== undefined) return;
      if ((issue.workModelSelection ?? null) !== null || issue.slackSource === null) return;
      const watch = (yield* Ref.get(watches)).get(issue.slackSource.channelId);
      if (watch?.autoAssign !== true) return;
      const claimed = yield* Ref.modify(routing, (current) =>
        current.has(issue.id)
          ? ([false, current] as const)
          : ([true, new Set(current).add(issue.id)] as const),
      );
      if (!claimed) return;
      yield* Effect.gen(function* () {
        const automation = yield* currentSettings;
        const cwd = yield* projectWorkspace(issue);
        if (cwd === null) return;

        const classification = yield* classify(issue, automation, cwd).pipe(
          Effect.orElseSucceed(() => ({
            routingRuleId: null,
            auditRuleIds: [] as ReadonlyArray<string>,
            rationale: "The router was unavailable, so the configured fallback was used.",
          })),
        );
        const rule =
          classification.routingRuleId === null
            ? undefined
            : automation.routingRules.find(
                (candidate) => candidate.id === classification.routingRuleId,
              );
        const selection = rule?.modelSelection ?? automation.fallbackModelSelection;
        if (selection === null) return;
        const instance = yield* providers.getInstance(selection.instanceId);
        if (instance === undefined || !instance.enabled) return;
        const assignedAt = DateTime.formatIso(yield* DateTime.now);
        yield* tracker.update(
          {
            issueId: issue.id,
            patch: {
              assignee: { kind: "agent", provider: instance.driverKind },
              workModelSelection: selection,
              automationAssignment: {
                routingRuleId: rule?.id ?? null,
                auditRuleIds: [...classification.auditRuleIds],
                rationale: classification.rationale,
                assignedAt,
              },
            },
          },
          AUTOMATION_ACTOR,
        );
        yield* tracker.commentCreate(
          {
            issueId: issue.id,
            body: `### Automatically assigned\n\n${classification.rationale}\n\n_Model: ${modelLabel(selection)}_`,
          },
          AUTOMATION_ACTOR,
        );
      }).pipe(
        Effect.ensuring(
          Ref.update(routing, (current) => {
            const next = new Set(current);
            next.delete(issue.id);
            return next;
          }),
        ),
      );
    });

  const auditWorkspace = Effect.fn("IssueAutomationCoordinator.auditWorkspace")(function* (
    issue: Issue,
  ) {
    const links = yield* threadLinks.listByIssue({ issueId: issue.id });
    const workLink = links.findLast((link) => link.origin === "start-work") ?? null;
    if (workLink !== null) {
      const projection = yield* threads.getThreadProjection(workLink.threadId);
      const cwd = projection.thread.worktreePath;
      if (cwd !== null) return { cwd, workLink };
    }
    return { cwd: yield* projectWorkspace(issue), workLink };
  });

  const runAuditor = Effect.fn("IssueAutomationCoordinator.runAuditor")(function* (input: {
    readonly issue: Issue;
    readonly rule: IssueAutomationAuditRule;
    readonly auditorIndex: number;
    readonly selection: ModelSelection;
    readonly triggerKey: string;
    readonly remediationCycle: number;
    readonly cwd: string;
  }) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const id = yield* crypto.randomUUIDv4;
    const running = {
      id,
      issueId: input.issue.id,
      triggerKey: input.triggerKey,
      ruleId: input.rule.id,
      auditorIndex: input.auditorIndex,
      modelSelection: input.selection,
      state: "running" as const,
      verdict: null,
      summary: null,
      findings: [],
      error: null,
      remediationCycle: input.remediationCycle,
      createdAt: now,
      finishedAt: null,
    };
    if (!(yield* audits.claim(running))) return;

    const generated = yield* Effect.result(
      textGeneration.investigate({
        cwd: input.cwd,
        prompt: buildIssueAutomationAuditPrompt({
          issue: input.issue,
          rule: input.rule,
          remediationCycle: input.remediationCycle,
        }),
        modelSelection: input.selection,
      }),
    );
    const finishedAt = DateTime.formatIso(yield* DateTime.now);
    if (Result.isFailure(generated)) {
      const detail = generated.failure.detail;
      yield* audits.finish({
        ...running,
        state: "failed",
        error: detail,
        finishedAt,
      });
      yield* tracker.commentCreate(
        {
          issueId: input.issue.id,
          body: `### Audit could not run — ${input.rule.name}\n\n${detail}\n\n_Model: ${modelLabel(input.selection)}_`,
        },
        AUTOMATION_ACTOR,
      );
      return;
    }
    const result = normalizeIssueAutomationAuditResult(generated.success.text);
    if (result === null) {
      yield* audits.finish({
        ...running,
        state: "failed",
        error: "The auditor did not return a usable verdict.",
        finishedAt,
      });
      yield* tracker.commentCreate(
        {
          issueId: input.issue.id,
          body: `### Audit could not run — ${input.rule.name}\n\nThe auditor did not return a usable verdict.\n\n_Model: ${modelLabel(input.selection)}_`,
        },
        AUTOMATION_ACTOR,
      );
      return;
    }
    yield* audits.finish({
      ...running,
      state: "done",
      verdict: result.verdict,
      summary: result.summary,
      findings: [...result.findings],
      finishedAt,
    });
    const instance = yield* providers.getInstance(input.selection.instanceId);
    yield* tracker.commentCreate(
      {
        issueId: input.issue.id,
        body: issueAutomationAuditComment({
          ruleName: input.rule.name,
          modelLabel: modelLabel(input.selection),
          result,
        }),
      },
      instance === undefined ? AUTOMATION_ACTOR : { kind: "agent", provider: instance.driverKind },
    );
  });

  const sendRemediation = Effect.fn("IssueAutomationCoordinator.sendRemediation")(
    function* (input: {
      readonly issue: Issue;
      readonly threadId: ThreadId;
      readonly findings: ReadonlyArray<string>;
    }) {
      const projectId = input.issue.projectId;
      if (projectId === null) return;
      const automation = yield* currentSettings;
      const snapshot = yield* tracker.getSnapshot();
      const transitions = resolveIssueAutomationStatuses({
        statuses: snapshot.statuses,
        transitions: automation.statusTransitions,
      });
      const reviewStatusName = snapshot.statuses.find(
        (status) => status.id === transitions.reviewStatusId,
      )?.name;
      const requestedWorkers = resolveIssueAutomationReviewWorkers({
        settings: automation,
        originalWorker: input.issue.workModelSelection,
      });
      const workers: Array<ModelSelection> = [];
      for (const selection of requestedWorkers) {
        const instance = yield* providers.getInstance(selection.instanceId);
        if (instance !== undefined && instance.enabled) workers.push(selection);
      }
      if (workers.length === 0) {
        yield* tracker.commentCreate(
          {
            issueId: input.issue.id,
            body: "Automation found blocking review findings, but no configured review worker is currently available.",
          },
          AUTOMATION_ACTOR,
        );
        return;
      }
      yield* Effect.forEach(
        workers,
        (selection, workerIndex) =>
          Effect.gen(function* () {
            const messageId = MessageId.make(`message:issue-audit:${yield* crypto.randomUUIDv4}`);
            yield* threads.sendToThread({
              projectId,
              commandId: CommandId.make(`issue-audit-remediation:${messageId}`),
              threadId: input.threadId,
              messageId,
              text: buildIssueAutomationRemediationPrompt({
                issue: input.issue,
                findings: input.findings,
                reviewStatusName: reviewStatusName ?? null,
                workerIndex,
                workerCount: workers.length,
              }),
              attachments: [],
              modelSelection: selection,
              mode: "queue",
              createdBy: "agent",
              creationSource: "server",
            });
          }),
        { concurrency: 1, discard: true },
      );
    },
  );

  const auditIssue = (issue: Issue, triggerKey: string) =>
    Effect.gen(function* () {
      // This settings page governs opted-in intake channels. Manually created and non-opted-in
      // issues keep their existing workflow unless they carry an automatic assignment decision.
      if ((issue.automationAssignment ?? null) === null) return;
      const claimed = yield* Ref.modify(auditing, (current) =>
        current.has(issue.id)
          ? ([false, current] as const)
          : ([true, new Set(current).add(issue.id)] as const),
      );
      if (!claimed) return;
      yield* Effect.gen(function* () {
        const automation = yield* currentSettings;
        const snapshot = yield* tracker.getSnapshot();
        const transitions = resolveIssueAutomationStatuses({
          statuses: snapshot.statuses,
          transitions: automation.statusTransitions,
        });
        const workspace = yield* auditWorkspace(issue);
        const cwd = workspace.cwd;
        if (cwd === null) return;
        let auditRuleIds = issue.automationAssignment?.auditRuleIds ?? [];
        if (auditRuleIds.length === 0 && automation.auditRules.length > 0) {
          const classification = yield* classify(issue, automation, cwd).pipe(
            Effect.orElseSucceed(() => null),
          );
          auditRuleIds = classification?.auditRuleIds ?? [];
        }
        const rules = automation.auditRules.filter((rule) => auditRuleIds.includes(rule.id));
        if (rules.length === 0) return;
        const remediationCycle = yield* audits.countChangesRequested(issue.id);
        yield* Effect.forEach(
          rules.flatMap((rule) =>
            rule.auditors.map((auditor, auditorIndex) => ({
              rule,
              selection: auditor.modelSelection,
              auditorIndex,
            })),
          ),
          ({ rule, selection, auditorIndex }) =>
            runAuditor({
              issue,
              rule,
              auditorIndex,
              selection,
              triggerKey,
              remediationCycle,
              cwd,
            }),
          { concurrency: 1, discard: true },
        );
        const runs = yield* audits.listByTrigger({ issueId: issue.id, triggerKey });
        const outcome = resolveIssueAutomationAuditOutcome(runs);
        if (outcome.kind === "pending") return;
        if (outcome.kind === "passed") {
          yield* updateStatus(issue, transitions.auditPassedStatusId);
          return;
        }
        yield* updateStatus(issue, transitions.auditChangesRequestedStatusId);
        const nextCycle = remediationCycle + 1;
        const findings = outcome.findings;
        if (workspace.workLink === null || nextCycle > automation.maxRemediationCycles) {
          yield* tracker.commentCreate(
            {
              issueId: issue.id,
              body:
                nextCycle > automation.maxRemediationCycles
                  ? `Automation stopped after ${automation.maxRemediationCycles} remediation cycles. The remaining findings need a person to decide.`
                  : "Automation could not return the findings to a linked work thread.",
            },
            AUTOMATION_ACTOR,
          );
          return;
        }
        yield* sendRemediation({
          issue,
          threadId: workspace.workLink.threadId,
          findings,
        });
      }).pipe(
        Effect.ensuring(
          Ref.update(auditing, (current) => {
            const next = new Set(current);
            next.delete(issue.id);
            return next;
          }),
        ),
      );
    });

  const handleIssueEvent = Effect.fn("IssueAutomationCoordinator.handleIssueEvent")(function* (
    event: IssuesStreamEvent,
  ) {
    if (shouldDeferLocalIssueAutomation() || isCompanyAutomationActive()) return;
    switch (event._tag) {
      case "SlackWatchesChanged":
        yield* Ref.set(watches, new Map(event.watches.map((watch) => [watch.channelId, watch])));
        return;
      case "IssueUpserted": {
        if (event.issue.slackSource?.integrationId !== undefined) return;
        const previous = (yield* Ref.get(issues)).get(event.issue.id);
        yield* Ref.update(issues, (current) => new Map(current).set(event.issue.id, event.issue));
        yield* Effect.forkChild(
          withLoggedFailure("issue.automation.route-failed", routeIssue(event.issue)),
        );
        const automation = yield* currentSettings;
        const snapshot = yield* tracker.getSnapshot();
        const transitions = resolveIssueAutomationStatuses({
          statuses: snapshot.statuses,
          transitions: automation.statusTransitions,
        });
        if (
          shouldTriggerIssueAutomationAudit({
            issue: event.issue,
            previousStatusId: previous?.statusId,
            reviewStatusId: transitions.reviewStatusId,
          })
        ) {
          yield* Effect.forkChild(
            withLoggedFailure(
              "issue.automation.audit-failed",
              auditIssue(event.issue, event.issue.updatedAt),
            ),
          );
        }
        return;
      }
      case "IssueThreadLinksChanged": {
        const workLink = event.links.findLast((link) => link.origin === "start-work");
        // Work starts when a start-work link *appears*, not while one exists. Anything else here
        // re-runs the status move and the assignment over a card that has since moved on.
        const mark = workLink === undefined ? null : startWorkMark(workLink);
        const appeared = yield* Ref.modify(startWorkLinks, (current) => {
          if (mark === null) {
            if (!current.has(event.issueId)) return [false, current] as const;
            const next = new Map(current);
            next.delete(event.issueId);
            return [false, next] as const;
          }
          if (current.get(event.issueId) === mark) return [false, current] as const;
          return [true, new Map(current).set(event.issueId, mark)] as const;
        });
        if (!appeared || workLink === undefined) return;
        const issue = (yield* Ref.get(issues)).get(event.issueId);
        if (issue === undefined) return;
        const automation = yield* currentSettings;
        const snapshot = yield* tracker.getSnapshot();
        const transitions = resolveIssueAutomationStatuses({
          statuses: snapshot.statuses,
          transitions: automation.statusTransitions,
        });
        const projection = yield* threads.getThreadProjection(workLink.threadId);
        const selection = projection.thread.modelSelection;
        const instance = yield* providers.getInstance(selection.instanceId);
        yield* tracker.update(
          {
            issueId: issue.id,
            patch: {
              ...(instance === undefined
                ? {}
                : { assignee: { kind: "agent" as const, provider: instance.driverKind } }),
              workModelSelection: selection,
              ...(transitions.workStartedStatusId === null
                ? {}
                : {
                    statusId: transitions.workStartedStatusId as IssueStatusId,
                  }),
            },
          },
          AUTOMATION_ACTOR,
        );
        return;
      }
      default:
        return;
    }
  });

  return handleIssueEvent;
});

export const make = Effect.gen(function* () {
  const tracker = yield* IssueTrackerService;
  const handleIssueEvent = yield* makeHandler;
  const issueLoop = Stream.runForEach(tracker.stream, (event) =>
    withLoggedFailure("issue.automation.event-failed", handleIssueEvent(event)),
  );
  yield* Effect.forkScoped(issueLoop);
});

export const layer = Layer.effectDiscard(make);
