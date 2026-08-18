// @effect-diagnostics anyUnknownInErrorContext:off unknownInEffectCatch:off
/** Company Slack polling runtime. Convex owns all state; this environment only executes a lease. */
import { api } from "@spiritdevs/backend/convexApi";
import {
  CommandId,
  Issue,
  IssueAutomationAuditRule,
  IssueAutomationSettings,
  MessageId,
  ModelSelection,
  ThreadId,
  type EnvironmentId,
} from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import type { FunctionReturnType } from "convex/server";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import {
  SlackApiClient,
  type SlackApiClientShape,
  type SlackIdentity,
  type SlackHistoryPage,
  type SlackMessage,
} from "../issues/slack/SlackApiClient.ts";
import { compareSlackTs } from "../issues/slack/SlackIntakePoller.ts";
import {
  buildIssueAutomationAuditPrompt,
  buildIssueAutomationClassificationPrompt,
  buildIssueAutomationRemediationPrompt,
  normalizeIssueAutomationAuditResult,
  normalizeIssueAutomationClassification,
} from "../issues/automation.ts";
import { slackMrkdwnToMarkdown, slackTitleFromText } from "../issues/slack/slackMrkdwn.ts";
import { forkParkedFiber } from "../serverActivation.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import {
  markCompanyAutomationAuthorityResolved,
  markCompanyIntegrationAuthorityResolved,
  replaceCompanyOwnedSlackWorkspaces,
  setCompanyAutomationActive,
} from "./companyIntegrationActivation.ts";
import type { ConvexServiceTokenProvider } from "./convexServiceToken.ts";
import { convexHttpClientLike, type ConvexClientLike } from "./convexSyncTransport.ts";
import {
  makeCloudSyncTokenProvider,
  readCloudSyncLink,
  resolveCloudSyncConfig,
} from "./syncDaemon.ts";

export const COMPANY_SLACK_POLL_INTERVAL_MS = 30_000;
const MAX_HISTORY_PAGES = 10;
const REACTION_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const REACTION_WINDOW_MESSAGES = 100;

type Integration = FunctionReturnType<typeof api.slackIntegrations.list>[number];
type Lease = FunctionReturnType<typeof api.slackIntegrations.heartbeat>;
type RuntimeWatch = FunctionReturnType<
  typeof api.slackOperations.runtimeConfiguration
>["watches"][number];
type JobSettings = FunctionReturnType<typeof api.issueAutomation.getSettings>;
type AutomationJob = FunctionReturnType<typeof api.issueAutomation.claim>[number];
type AutomationContext = FunctionReturnType<typeof api.issueAutomation.executionContext>;

export interface CompanySlackBackend {
  readonly listIntegrations: (
    companyId: string,
  ) => Effect.Effect<ReadonlyArray<Integration>, unknown>;
  readonly ownedWorkspaceIds: (companyId: string) => Effect.Effect<ReadonlyArray<string>, unknown>;
  readonly automationSettings: (companyId: string) => Effect.Effect<JobSettings, unknown>;
  readonly publishCapabilities: (input: {
    companyId: string;
    revision: number;
    supportsSlackCoordination: boolean;
    supportsAutomationJobs: boolean;
    providers: ReadonlyArray<{
      readonly instanceId: string;
      readonly driverKind: string;
      readonly enabled: boolean;
      readonly available: boolean;
      readonly modelIds: ReadonlyArray<string>;
    }>;
  }) => Effect.Effect<void, unknown>;
  readonly claimJobs: (companyId: string) => Effect.Effect<ReadonlyArray<AutomationJob>, unknown>;
  readonly renewJob: (input: {
    companyId: string;
    jobId: string;
    claimGeneration: number;
  }) => Effect.Effect<void, unknown>;
  readonly markJobRunning: (input: {
    companyId: string;
    jobId: string;
    claimGeneration: number;
  }) => Effect.Effect<void, unknown>;
  readonly jobContext: (input: {
    companyId: string;
    jobId: string;
    claimGeneration: number;
  }) => Effect.Effect<AutomationContext, unknown>;
  readonly reportJob: (input: {
    companyId: string;
    jobId: string;
    claimGeneration: number;
    outcome: "succeeded" | "transient-failure" | "blocked";
    result: AutomationJob["result"];
    blockCode:
      | "environment-offline"
      | "project-binding-missing"
      | "thread-environment-offline"
      | "provider-instance-missing"
      | "provider-disabled"
      | "model-unavailable"
      | "configuration-changed"
      | "authorization-revoked"
      | null;
    diagnostic: string | null;
  }) => Effect.Effect<AutomationJob, unknown>;
  readonly heartbeat: (input: {
    companyId: string;
    integrationId: string;
    healthy: boolean;
    capabilityRevision: number;
  }) => Effect.Effect<Lease, unknown>;
  readonly credential: (input: {
    companyId: string;
    integrationId: string;
    generation: number;
  }) => Effect.Effect<{ readonly workspaceId: string; readonly token: string }, unknown>;
  readonly configuration: (input: {
    companyId: string;
    integrationId: string;
    generation: number;
  }) => Effect.Effect<FunctionReturnType<typeof api.slackOperations.runtimeConfiguration>, unknown>;
  readonly readCursor: (input: {
    companyId: string;
    integrationId: string;
    generation: number;
    channelId: string;
  }) => Effect.Effect<FunctionReturnType<typeof api.slackOperations.readCursor>, unknown>;
  readonly updateCursor: (input: {
    companyId: string;
    integrationId: string;
    generation: number;
    channelId: string;
    messageCursor: string | null;
    reactionCursor: string | null;
  }) => Effect.Effect<void, unknown>;
  readonly createIssue: (input: {
    companyId: string;
    integrationId: string;
    generation: number;
    channelId: string;
    messageTs: string;
    routeEmoji: string | null;
    title: string;
    description: string;
    permalink: string | null;
    authorName: string | null;
  }) => Effect.Effect<
    { readonly created: boolean; readonly issueId: string; readonly issueKey: string },
    unknown
  >;
  readonly addReply: (input: {
    companyId: string;
    integrationId: string;
    generation: number;
    channelId: string;
    rootMessageTs: string;
    messageTs: string;
    authorName: string | null;
    body: string;
  }) => Effect.Effect<{ readonly created: boolean; readonly issueId: string }, unknown>;
  readonly threadsForReplyScan: (input: {
    companyId: string;
    integrationId: string;
    generation: number;
    channelId: string;
    limit?: number;
  }) => Effect.Effect<ReadonlyArray<{ readonly threadTs: string }>, unknown>;
  readonly markThreadReplyScanned: (input: {
    companyId: string;
    integrationId: string;
    generation: number;
    channelId: string;
    threadTs: string;
  }) => Effect.Effect<void, unknown>;
  readonly recordIgnored: (input: {
    companyId: string;
    integrationId: string;
    generation: number;
    channelId: string;
    messageTs: string;
    reason: string;
  }) => Effect.Effect<void, unknown>;
  readonly pendingDeliveries: (input: {
    companyId: string;
    integrationId: string;
    generation: number;
  }) => Effect.Effect<FunctionReturnType<typeof api.slackOperations.pendingDeliveries>, unknown>;
  readonly claimDelivery: (input: {
    companyId: string;
    integrationId: string;
    generation: number;
    deliveryId: string;
    channelId: string;
    threadTs: string;
    kind: "confirmation" | "comment" | "status";
    text?: string;
  }) => Effect.Effect<FunctionReturnType<typeof api.slackOperations.claimDelivery>, unknown>;
  readonly completeDelivery: (input: {
    companyId: string;
    integrationId: string;
    generation: number;
    deliveryId: string;
    claimGeneration: number;
    slackMessageTs: string;
  }) => Effect.Effect<void, unknown>;
  readonly updateHealth: (input: {
    companyId: string;
    integrationId: string;
    generation: number;
    lastPollAt: number | null;
    error: string | null;
  }) => Effect.Effect<void, unknown>;
}

function isAuthorizationFailure(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes("401") || text.includes("403") || text.includes("not-authenticated");
}

export const makeCompanySlackBackend = Effect.fn("cloud.company_slack.backend")(function* (input: {
  readonly convexUrl: string;
  readonly tokens: ConvexServiceTokenProvider;
  readonly client?: ConvexClientLike;
}) {
  const client = input.client ?? convexHttpClientLike(input.convexUrl);
  const lock = yield* Semaphore.make(1);
  const issue = <A>(token: string, call: (convex: ConvexClientLike) => Promise<A>) =>
    lock.withPermits(1)(
      Effect.sync(() => client.setAuth(token)).pipe(
        Effect.andThen(Effect.tryPromise({ try: () => call(client), catch: (error) => error })),
      ),
    );
  const authorized = <A>(call: (convex: ConvexClientLike) => Promise<A>) =>
    input.tokens.token.pipe(
      Effect.flatMap((token) =>
        issue(token, call).pipe(
          Effect.catchIf(isAuthorizationFailure, () =>
            input.tokens.invalidate(token).pipe(
              Effect.andThen(input.tokens.token),
              Effect.flatMap((fresh) => issue(fresh, call)),
            ),
          ),
        ),
      ),
    );
  const action = <A>(call: (run: NonNullable<ConvexClientLike["action"]>) => Promise<A>) =>
    authorized((convex) => {
      if (convex.action === undefined)
        return Promise.reject(new Error("Convex actions are unavailable."));
      return call(convex.action.bind(convex));
    });
  return {
    listIntegrations: (companyId) =>
      authorized((convex) => convex.query(api.slackIntegrations.list, { companyId })),
    ownedWorkspaceIds: (companyId) =>
      authorized((convex) => convex.query(api.slackIntegrations.ownedWorkspaceIds, { companyId })),
    automationSettings: (companyId) =>
      authorized((convex) => convex.query(api.issueAutomation.getSettings, { companyId })),
    publishCapabilities: (args) =>
      authorized((convex) =>
        convex.mutation(api.slackIntegrations.publishCapabilities, {
          ...args,
          providers: args.providers.map((provider) => ({
            ...provider,
            modelIds: [...provider.modelIds],
          })),
        }),
      ),
    claimJobs: (companyId) =>
      authorized((convex) => convex.mutation(api.issueAutomation.claim, { companyId, limit: 5 })),
    renewJob: (args) => authorized((convex) => convex.mutation(api.issueAutomation.renew, args)),
    markJobRunning: (args) =>
      authorized((convex) => convex.mutation(api.issueAutomation.markRunning, args)),
    jobContext: (args) =>
      authorized((convex) => convex.query(api.issueAutomation.executionContext, args)),
    reportJob: (args) => authorized((convex) => convex.mutation(api.issueAutomation.report, args)),
    heartbeat: (args) =>
      authorized((convex) => convex.mutation(api.slackIntegrations.heartbeat, args)),
    credential: (args) => action((run) => run(api.slackIntegrations.runtimeCredential, args)),
    configuration: (args) =>
      authorized((convex) => convex.query(api.slackOperations.runtimeConfiguration, args)),
    readCursor: (args) =>
      authorized((convex) => convex.query(api.slackOperations.readCursor, args)),
    updateCursor: (args) =>
      authorized((convex) => convex.mutation(api.slackOperations.updateCursor, args)),
    createIssue: (args) =>
      authorized((convex) => convex.mutation(api.slackOperations.createIssue, args)),
    addReply: (args) => authorized((convex) => convex.mutation(api.slackOperations.addReply, args)),
    threadsForReplyScan: (args) =>
      authorized((convex) => convex.query(api.slackOperations.threadsForReplyScan, args)),
    markThreadReplyScanned: (args) =>
      authorized((convex) => convex.mutation(api.slackOperations.markThreadReplyScanned, args)),
    recordIgnored: (args) =>
      authorized((convex) => convex.mutation(api.slackOperations.recordIgnored, args)),
    pendingDeliveries: (args) =>
      authorized((convex) => convex.query(api.slackOperations.pendingDeliveries, args)),
    claimDelivery: (args) =>
      authorized((convex) => convex.mutation(api.slackOperations.claimDelivery, args)),
    completeDelivery: (args) =>
      authorized((convex) => convex.mutation(api.slackOperations.completeDelivery, args)),
    updateHealth: (args) =>
      authorized((convex) => convex.mutation(api.slackIntegrations.updateHealth, args)),
  } satisfies CompanySlackBackend;
});

function isReadable(message: SlackMessage): boolean {
  return message.subtype === undefined || message.subtype === "file_share";
}

function isBot(message: SlackMessage, identity: SlackIdentity): boolean {
  return (
    message.subtype === "bot_message" ||
    message.bot_id !== undefined ||
    message.app_id !== undefined ||
    (identity.botUserId !== null && message.user === identity.botUserId)
  );
}

function reactionRoute(watch: RuntimeWatch, message: SlackMessage): string | null {
  const routes = Array.isArray((watch.trigger as Record<string, unknown>)["reactionRoutes"])
    ? ((watch.trigger as Record<string, unknown>)["reactionRoutes"] as ReadonlyArray<unknown>)
    : [];
  const reactions = new Set((message.reactions ?? []).map((reaction) => reaction.name));
  for (const raw of routes) {
    if (typeof raw !== "object" || raw === null) continue;
    const emoji = (raw as Record<string, unknown>)["emoji"];
    if (typeof emoji === "string" && reactions.has(emoji)) return emoji;
  }
  return null;
}

function messageRoute(watch: RuntimeWatch, message: SlackMessage, identity: SlackIdentity) {
  const emoji = reactionRoute(watch, message);
  if (emoji !== null) return { matched: true as const, emoji };
  const trigger = watch.trigger as Record<string, unknown>;
  if (trigger["everyMessage"] === true) return { matched: true as const, emoji: null };
  if (
    trigger["botMention"] === true &&
    identity.botUserId !== null &&
    (message.text ?? "").includes(`<@${identity.botUserId}>`)
  ) {
    return { matched: true as const, emoji: null };
  }
  return { matched: false as const, emoji: null };
}

const displayName = (
  slack: SlackApiClientShape,
  token: string,
  message: SlackMessage,
): Effect.Effect<string | null, unknown> =>
  message.username !== undefined
    ? Effect.succeed(message.username)
    : message.user === undefined
      ? Effect.succeed(null)
      : slack.displayName({ token, userId: message.user });

function deliveryId(issueId: string): string {
  return `slack-confirmation-${issueId}`;
}

function hasDeliveryMetadata(messages: ReadonlyArray<SlackMessage>, id: string): string | null {
  for (const message of messages) {
    if (
      message.metadata?.event_type === "pathway_delivery" &&
      message.metadata.event_payload["delivery_id"] === id
    ) {
      return message.ts;
    }
  }
  return null;
}

const confirmCreatedIssue = Effect.fn("cloud.company_slack.confirm_created_issue")(
  function* (input: {
    readonly runtime: CompanySlackRuntime;
    readonly integrationId: string;
    readonly generation: number;
    readonly token: string;
    readonly channelId: string;
    readonly messageTs: string;
    readonly issueId: string;
    readonly issueKey: string;
  }) {
    const id = deliveryId(input.issueId);
    const claim = yield* input.runtime.backend.claimDelivery({
      companyId: input.runtime.companyId,
      integrationId: input.integrationId,
      generation: input.generation,
      deliveryId: id,
      channelId: input.channelId,
      threadTs: input.messageTs,
      kind: "confirmation",
      text: `Filed as ${input.issueKey}`,
    });
    if (claim.state === "succeeded") return;
    const replies = yield* input.runtime.slack.replies({
      token: input.token,
      channelId: input.channelId,
      threadTs: input.messageTs,
      includeAllMetadata: true,
    });
    const reconciled = hasDeliveryMetadata(replies, id);
    const postedTs =
      reconciled ??
      (yield* input.runtime.slack.postToThread({
        token: input.token,
        channelId: input.channelId,
        threadTs: input.messageTs,
        text: `Filed as ${input.issueKey}`,
        metadata: { eventType: "pathway_delivery", eventPayload: { delivery_id: id } },
      })).messageTs;
    yield* input.runtime.backend.completeDelivery({
      companyId: input.runtime.companyId,
      integrationId: input.integrationId,
      generation: input.generation,
      deliveryId: id,
      claimGeneration: claim.claimGeneration,
      slackMessageTs: postedTs,
    });
  },
);

const attachThreadReplies = Effect.fn("cloud.company_slack.attach_thread_replies")(
  function* (input: {
    readonly runtime: CompanySlackRuntime;
    readonly integrationId: string;
    readonly generation: number;
    readonly token: string;
    readonly identity: SlackIdentity;
    readonly channelId: string;
    readonly threadTs: string;
  }) {
    const replies = yield* input.runtime.slack.replies({
      token: input.token,
      channelId: input.channelId,
      threadTs: input.threadTs,
    });
    for (const reply of replies) {
      if (reply.ts === input.threadTs || !isReadable(reply) || isBot(reply, input.identity))
        continue;
      const authorName = yield* displayName(input.runtime.slack, input.token, reply);
      yield* input.runtime.backend.addReply({
        companyId: input.runtime.companyId,
        integrationId: input.integrationId,
        generation: input.generation,
        channelId: input.channelId,
        rootMessageTs: input.threadTs,
        messageTs: reply.ts,
        authorName,
        body: slackMrkdwnToMarkdown(reply.text ?? ""),
      });
    }
    yield* input.runtime.backend.markThreadReplyScanned({
      companyId: input.runtime.companyId,
      integrationId: input.integrationId,
      generation: input.generation,
      channelId: input.channelId,
      threadTs: input.threadTs,
    });
  },
);

type PublishedProviderCapability = {
  readonly instanceId: string;
  readonly driverKind: string;
  readonly enabled: boolean;
  readonly available: boolean;
  readonly modelIds: ReadonlyArray<string>;
};

export interface CompanySlackRuntime {
  readonly companyId: CompanyId;
  readonly environmentId: EnvironmentId;
  readonly backend: CompanySlackBackend;
  readonly slack: SlackApiClientShape;
  readonly now: () => number;
  readonly automation?: CompanyAutomationExecutor | undefined;
  readonly providers?: ReadonlyArray<PublishedProviderCapability> | undefined;
  readonly readProviders?:
    | (() => Effect.Effect<ReadonlyArray<PublishedProviderCapability>, unknown>)
    | undefined;
}

function capabilityRevision(providers: ReadonlyArray<PublishedProviderCapability>): number {
  let hash = 2_166_136_261;
  const serialized = JSON.stringify(providers);
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

type AutomationExecutionResult =
  | { readonly outcome: "succeeded"; readonly result: AutomationJob["result"] }
  | {
      readonly outcome: "blocked";
      readonly blockCode:
        | "project-binding-missing"
        | "thread-environment-offline"
        | "provider-instance-missing"
        | "provider-disabled"
        | "model-unavailable"
        | "configuration-changed";
      readonly diagnostic: string;
    };

export interface CompanyAutomationExecutor {
  readonly execute: (
    job: AutomationJob,
    context: AutomationContext,
  ) => Effect.Effect<AutomationExecutionResult, unknown>;
}

function decodeJobSelection(value: unknown): ModelSelection | null {
  return Schema.decodeUnknownOption(ModelSelection)(value).pipe(
    // This boundary deliberately does not invent a provider/model fallback.
    (option) => (option._tag === "Some" ? option.value : null),
  );
}

const jobWorkspace = Effect.fn("cloud.company_automation.workspace")(function* (
  job: AutomationJob,
  context: AutomationContext,
  threads: ThreadManagementService["Service"],
) {
  if (context.localWorkspaceRoot !== null) return context.localWorkspaceRoot;
  if (job.threadId === null) return null;
  const projection = yield* threads.getThreadProjection(ThreadId.make(job.threadId));
  return projection.thread.worktreePath;
});

export const makeCompanyAutomationExecutor = Effect.fn("cloud.company_automation.executor")(
  function* () {
    const textGeneration = yield* TextGeneration;
    const providerRegistry = yield* ProviderInstanceRegistry;
    const threads = yield* ThreadManagementService;

    const requireSelection = Effect.fn("cloud.company_automation.selection")(function* (
      value: unknown,
    ) {
      const selection = decodeJobSelection(value);
      if (selection === null) {
        return {
          ok: false as const,
          result: {
            outcome: "blocked" as const,
            blockCode: "provider-instance-missing" as const,
            diagnostic: "The job has no valid provider/model selection.",
          },
        };
      }
      const instance = yield* providerRegistry.getInstance(selection.instanceId);
      if (instance === undefined) {
        return {
          ok: false as const,
          result: {
            outcome: "blocked" as const,
            blockCode: "provider-instance-missing" as const,
            diagnostic: `Provider instance ${selection.instanceId} is unavailable.`,
          },
        };
      }
      if (!instance.enabled) {
        return {
          ok: false as const,
          result: {
            outcome: "blocked" as const,
            blockCode: "provider-disabled" as const,
            diagnostic: `Provider instance ${selection.instanceId} is disabled.`,
          },
        };
      }
      const snapshot = yield* instance.snapshot.getSnapshot;
      if (!snapshot.models.some((model) => model.slug === selection.model)) {
        return {
          ok: false as const,
          result: {
            outcome: "blocked" as const,
            blockCode: "model-unavailable" as const,
            diagnostic: `Model ${selection.model} is unavailable on ${selection.instanceId}.`,
          },
        };
      }
      return { ok: true as const, selection, instance };
    });

    const execute: CompanyAutomationExecutor["execute"] = Effect.fn(
      "cloud.company_automation.execute",
    )(function* (job, context) {
      const issue = yield* Schema.decodeUnknownEffect(Issue)(context.issue);
      const cwd = yield* jobWorkspace(job, context, threads);
      if (cwd === null && job.kind !== "remediation-dispatch") {
        return {
          outcome: "blocked",
          blockCode:
            job.targetKind === "thread" ? "thread-environment-offline" : "project-binding-missing",
          diagnostic: "The target workspace is not available on this environment.",
        };
      }
      const selected = yield* requireSelection(job.modelSelection);
      if (!selected.ok) return selected.result;

      if (job.kind === "slack-investigation") {
        const generated = yield* textGeneration.investigate({
          cwd: cwd!,
          prompt: `Investigate this issue in the repository. Return a concise evidence-backed report with likely cause, relevant files, and recommended next step. Do not modify files.\n\nIssue ${issue.key}: ${issue.title}\n\n${issue.description}`,
          modelSelection: selected.selection,
        });
        return {
          outcome: "succeeded",
          result: { kind: "investigation", summary: generated.text },
        };
      }

      if (job.kind === "automatic-assignment") {
        if (job.ruleSnapshot === null) {
          return {
            outcome: "blocked",
            blockCode: "configuration-changed",
            diagnostic: "The immutable routing snapshot is missing.",
          };
        }
        const settings = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(IssueAutomationSettings),
        )(job.ruleSnapshot);
        const generated = yield* textGeneration.investigate({
          cwd: cwd!,
          prompt: buildIssueAutomationClassificationPrompt({
            issue,
            routingRules: settings.routingRules,
            auditRules: settings.auditRules,
          }),
          modelSelection: selected.selection,
        });
        const classification = normalizeIssueAutomationClassification(generated.text, settings) ?? {
          routingRuleId: null,
          auditRuleIds: [] as ReadonlyArray<string>,
          rationale: "The router returned no matching rule, so the configured fallback was used.",
        };
        const rule =
          classification.routingRuleId === null
            ? undefined
            : settings.routingRules.find(
                (candidate) => candidate.id === classification.routingRuleId,
              );
        const assignmentSelection = rule?.modelSelection ?? settings.fallbackModelSelection;
        if (assignmentSelection === null) {
          return {
            outcome: "blocked",
            blockCode: "configuration-changed",
            diagnostic: "No matching worker or fallback model is configured.",
          };
        }
        const assignment = yield* requireSelection(assignmentSelection);
        if (!assignment.ok) return assignment.result;
        return {
          outcome: "succeeded",
          result: {
            kind: "assignment",
            routingRuleId: rule?.id ?? null,
            auditRuleIds: [...classification.auditRuleIds],
            rationale: classification.rationale,
            modelSelection: assignment.selection,
            driverKind: assignment.instance.driverKind,
          },
        };
      }

      if (job.kind === "audit-execution") {
        if (job.ruleSnapshot === null) {
          return {
            outcome: "blocked",
            blockCode: "configuration-changed",
            diagnostic: "The immutable audit rule snapshot is missing.",
          };
        }
        const rule = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(IssueAutomationAuditRule),
        )(job.ruleSnapshot);
        const generated = yield* textGeneration.investigate({
          cwd: cwd!,
          prompt: buildIssueAutomationAuditPrompt({ issue, rule, remediationCycle: 0 }),
          modelSelection: selected.selection,
        });
        const result = normalizeIssueAutomationAuditResult(generated.text);
        if (result === null)
          return yield* Effect.fail("The auditor did not return a usable verdict.");
        return {
          outcome: "succeeded",
          result: {
            kind: "audit",
            outcome: result.verdict === "changes_requested" ? "changes-requested" : "passed",
            summary: result.summary,
            findings: [...result.findings],
          },
        };
      }

      if (job.kind === "remediation-dispatch") {
        if (job.threadId === null || job.ruleSnapshot === null) {
          return {
            outcome: "blocked",
            blockCode: "thread-environment-offline",
            diagnostic: "The linked work thread is unavailable.",
          };
        }
        const projection = yield* threads.getThreadProjection(ThreadId.make(job.threadId));
        const snapshot = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(
            Schema.Struct({ worker: Schema.Unknown, findings: Schema.Array(Schema.String) }),
          ),
        )(job.ruleSnapshot);
        yield* threads.sendToThread({
          projectId: projection.thread.projectId,
          commandId: CommandId.make(`company-automation:${job.id}`),
          threadId: ThreadId.make(job.threadId),
          messageId: MessageId.make(`message:company-automation:${job.id}`),
          text: buildIssueAutomationRemediationPrompt({
            issue,
            findings: snapshot.findings,
            reviewStatusName: null,
            workerIndex: 0,
            workerCount: 1,
          }),
          attachments: [],
          modelSelection: selected.selection,
          mode: "queue",
          createdBy: "agent",
          creationSource: "server",
        });
        return { outcome: "succeeded", result: { kind: "remediation", dispatched: true } };
      }

      return { outcome: "succeeded", result: job.result ?? null };
    });
    return { execute } satisfies CompanyAutomationExecutor;
  },
);

const runAutomationJobs = Effect.fn("cloud.company_automation.run_jobs")(function* (
  runtime: CompanySlackRuntime,
) {
  if (runtime.automation === undefined) return;
  const jobs = yield* runtime.backend.claimJobs(runtime.companyId);
  yield* Effect.forEach(
    jobs,
    (job) =>
      Effect.scoped(
        Effect.gen(function* () {
          yield* runtime.backend.markJobRunning({
            companyId: runtime.companyId,
            jobId: job.id,
            claimGeneration: job.claimGeneration,
          });
          yield* Effect.forkScoped(
            Effect.sleep(Duration.seconds(30)).pipe(
              Effect.andThen(
                runtime.backend.renewJob({
                  companyId: runtime.companyId,
                  jobId: job.id,
                  claimGeneration: job.claimGeneration,
                }),
              ),
              Effect.forever,
            ),
          );
          const context = yield* runtime.backend.jobContext({
            companyId: runtime.companyId,
            jobId: job.id,
            claimGeneration: job.claimGeneration,
          });
          const result = yield* Effect.result(runtime.automation!.execute(job, context));
          if (result._tag === "Failure") {
            yield* runtime.backend.reportJob({
              companyId: runtime.companyId,
              jobId: job.id,
              claimGeneration: job.claimGeneration,
              outcome: "transient-failure",
              result: null,
              blockCode: null,
              diagnostic: "The automation provider failed before producing a result.",
            });
            return;
          }
          if (result.success.outcome === "blocked") {
            yield* runtime.backend.reportJob({
              companyId: runtime.companyId,
              jobId: job.id,
              claimGeneration: job.claimGeneration,
              outcome: "blocked",
              result: null,
              blockCode: result.success.blockCode,
              diagnostic: result.success.diagnostic,
            });
            return;
          }
          yield* runtime.backend.reportJob({
            companyId: runtime.companyId,
            jobId: job.id,
            claimGeneration: job.claimGeneration,
            outcome: "succeeded",
            result: result.success.result,
            blockCode: null,
            diagnostic: null,
          });
        }),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Company automation job failed", { jobId: job.id, cause }),
        ),
      ),
    { concurrency: 2, discard: true },
  );
});

const runCompanyAutomationCycle = Effect.fn("cloud.company_automation.cycle")(function* (
  runtime: CompanySlackRuntime,
) {
  const automation = yield* runtime.backend.automationSettings(runtime.companyId);
  setCompanyAutomationActive(automation !== null && automation.activatedAt !== null);
  markCompanyAutomationAuthorityResolved();
  if (automation?.enabled === true) yield* runAutomationJobs(runtime);
});

export const runCompanySlackCycle = Effect.fn("cloud.company_slack.cycle")(function* (
  runtime: CompanySlackRuntime,
) {
  const providers = runtime.readProviders
    ? yield* runtime.readProviders()
    : (runtime.providers ?? []);
  const providerCapabilityRevision = capabilityRevision(providers);
  yield* runtime.backend.publishCapabilities({
    companyId: runtime.companyId,
    revision: providerCapabilityRevision,
    supportsSlackCoordination: true,
    supportsAutomationJobs: runtime.automation !== undefined,
    providers,
  });
  const [integrations, ownedWorkspaceIds] = yield* Effect.all([
    runtime.backend.listIntegrations(runtime.companyId),
    runtime.backend.ownedWorkspaceIds(runtime.companyId),
  ]);
  replaceCompanyOwnedSlackWorkspaces(ownedWorkspaceIds);
  markCompanyIntegrationAuthorityResolved();

  for (const integration of integrations) {
    if (integration.state !== "active") continue;
    if (
      integration.preferredEnvironmentId !== runtime.environmentId &&
      !integration.backupEnvironmentIds.includes(runtime.environmentId)
    ) {
      continue;
    }
    const lease = yield* runtime.backend.heartbeat({
      companyId: runtime.companyId,
      integrationId: integration.id,
      healthy: true,
      capabilityRevision: providerCapabilityRevision,
    });
    if (lease.holderEnvironmentId !== runtime.environmentId || lease.expiresAt === null) continue;
    const generation = lease.generation;
    const startupFailure = (error: string) =>
      runtime.backend.updateHealth({
        companyId: runtime.companyId,
        integrationId: integration.id,
        generation,
        lastPollAt: null,
        error,
      });
    const credentialResult = yield* Effect.result(
      runtime.backend.credential({
        companyId: runtime.companyId,
        integrationId: integration.id,
        generation,
      }),
    );
    if (credentialResult._tag === "Failure") {
      yield* startupFailure("The encrypted Slack credential could not be opened.");
      continue;
    }
    const credential = credentialResult.success;
    const identityResult = yield* Effect.result(
      runtime.slack.authTest({ token: credential.token }),
    );
    if (identityResult._tag === "Failure") {
      yield* startupFailure("Slack rejected or could not validate the current credential.");
      continue;
    }
    const identity = identityResult.success;
    if (
      identity.workspaceId !== integration.workspaceId ||
      credential.workspaceId !== integration.workspaceId
    ) {
      yield* startupFailure("Slack returned a different workspace than this integration owns.");
      continue;
    }
    const configResult = yield* Effect.result(
      runtime.backend.configuration({
        companyId: runtime.companyId,
        integrationId: integration.id,
        generation,
      }),
    );
    if (configResult._tag === "Failure") {
      yield* startupFailure("The shared Slack watch configuration could not be loaded.");
      continue;
    }
    const config = configResult.success;
    let firstError: string | null = null;
    for (const watch of config.watches) {
      const trigger = watch.trigger as Record<string, unknown>;
      const active =
        trigger["everyMessage"] === true ||
        trigger["botMention"] === true ||
        (Array.isArray(trigger["reactionRoutes"]) && trigger["reactionRoutes"].length > 0);
      if (!active) continue;
      const pass = Effect.gen(function* () {
        const cursor = yield* runtime.backend.readCursor({
          companyId: runtime.companyId,
          integrationId: integration.id,
          generation,
          channelId: watch.channelId,
        });
        const collected: SlackMessage[] = [];
        let pageCursor: string | null = null;
        for (let page = 0; page < MAX_HISTORY_PAGES; page += 1) {
          const answer: SlackHistoryPage = yield* runtime.slack.history({
            token: credential.token,
            channelId: watch.channelId,
            oldest: cursor.messageCursor,
            cursor: pageCursor,
          });
          collected.push(...answer.messages);
          pageCursor = answer.hasMore ? answer.nextCursor : null;
          if (pageCursor === null) break;
        }
        const ordered = collected.sort((left, right) => compareSlackTs(left.ts, right.ts));
        for (const message of ordered) {
          if (!isReadable(message) || isBot(message, identity)) continue;
          const authorName = yield* displayName(runtime.slack, credential.token, message);
          const body = slackMrkdwnToMarkdown(message.text ?? "");
          if (message.thread_ts !== undefined && message.thread_ts !== message.ts) {
            yield* runtime.backend
              .addReply({
                companyId: runtime.companyId,
                integrationId: integration.id,
                generation,
                channelId: watch.channelId,
                rootMessageTs: message.thread_ts,
                messageTs: message.ts,
                authorName,
                body,
              })
              .pipe(Effect.catch(() => Effect.void));
            continue;
          }
          const route = messageRoute(watch, message, identity);
          if (!route.matched) {
            yield* runtime.backend.recordIgnored({
              companyId: runtime.companyId,
              integrationId: integration.id,
              generation,
              channelId: watch.channelId,
              messageTs: message.ts,
              reason: "no-trigger",
            });
            continue;
          }
          const permalink = yield* runtime.slack
            .permalink({
              token: credential.token,
              channelId: watch.channelId,
              messageTs: message.ts,
            })
            .pipe(Effect.orElseSucceed(() => null));
          const created = yield* runtime.backend.createIssue({
            companyId: runtime.companyId,
            integrationId: integration.id,
            generation,
            channelId: watch.channelId,
            messageTs: message.ts,
            routeEmoji: route.emoji,
            title: slackTitleFromText(body),
            description: body.trim().length === 0 ? "" : `**Slack comment:**\n\n${body}`,
            permalink,
            authorName,
          });
          if (!created.created) continue;
          if ((message.reply_count ?? 0) > 0) {
            yield* attachThreadReplies({
              runtime,
              integrationId: integration.id,
              generation,
              token: credential.token,
              identity,
              channelId: watch.channelId,
              threadTs: message.ts,
            });
          }
          yield* confirmCreatedIssue({
            runtime,
            integrationId: integration.id,
            generation,
            token: credential.token,
            channelId: watch.channelId,
            messageTs: message.ts,
            issueId: created.issueId,
            issueKey: created.issueKey,
          });
        }

        const reactionFloor = cursor.reactionCursor;
        if (Array.isArray(trigger["reactionRoutes"]) && trigger["reactionRoutes"].length > 0) {
          const page = yield* runtime.slack.history({
            token: credential.token,
            channelId: watch.channelId,
            oldest: reactionFloor,
            limit: REACTION_WINDOW_MESSAGES,
          });
          for (const message of [...page.messages].sort((a, b) => compareSlackTs(a.ts, b.ts))) {
            if (message.thread_ts !== undefined || reactionRoute(watch, message) === null) continue;
            if (!isReadable(message) || isBot(message, identity)) continue;
            const body = slackMrkdwnToMarkdown(message.text ?? "");
            const authorName = yield* displayName(runtime.slack, credential.token, message);
            const created = yield* runtime.backend.createIssue({
              companyId: runtime.companyId,
              integrationId: integration.id,
              generation,
              channelId: watch.channelId,
              messageTs: message.ts,
              routeEmoji: reactionRoute(watch, message),
              title: slackTitleFromText(body),
              description: body.trim().length === 0 ? "" : `**Slack comment:**\n\n${body}`,
              permalink: null,
              authorName,
            });
            if (created.created) {
              if ((message.reply_count ?? 0) > 0) {
                yield* attachThreadReplies({
                  runtime,
                  integrationId: integration.id,
                  generation,
                  token: credential.token,
                  identity,
                  channelId: watch.channelId,
                  threadTs: message.ts,
                });
              }
              yield* confirmCreatedIssue({
                runtime,
                integrationId: integration.id,
                generation,
                token: credential.token,
                channelId: watch.channelId,
                messageTs: message.ts,
                issueId: created.issueId,
                issueKey: created.issueKey,
              });
            }
          }
        }
        const replyThreads = yield* runtime.backend.threadsForReplyScan({
          companyId: runtime.companyId,
          integrationId: integration.id,
          generation,
          channelId: watch.channelId,
          limit: 10,
        });
        for (const thread of replyThreads) {
          yield* attachThreadReplies({
            runtime,
            integrationId: integration.id,
            generation,
            token: credential.token,
            identity,
            channelId: watch.channelId,
            threadTs: thread.threadTs,
          });
        }
        const newest = ordered.reduce<string | null>(
          (current, message) =>
            current === null || compareSlackTs(current, message.ts) < 0 ? message.ts : current,
          cursor.messageCursor,
        );
        const floor = `${Math.floor((runtime.now() - REACTION_WINDOW_SECONDS * 1_000) / 1_000)}.000000`;
        yield* runtime.backend.updateCursor({
          companyId: runtime.companyId,
          integrationId: integration.id,
          generation,
          channelId: watch.channelId,
          messageCursor: newest,
          reactionCursor:
            reactionFloor === null || compareSlackTs(reactionFloor, floor) < 0
              ? floor
              : reactionFloor,
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            firstError ??= `#${watch.channelName}: ${error instanceof Error ? error.message : String(error)}`;
          }),
        ),
      );
      yield* pass;
    }
    const outbound = yield* runtime.backend.pendingDeliveries({
      companyId: runtime.companyId,
      integrationId: integration.id,
      generation,
    });
    for (const delivery of outbound) {
      const pass = Effect.gen(function* () {
        const claim = yield* runtime.backend.claimDelivery({
          companyId: runtime.companyId,
          integrationId: integration.id,
          generation,
          deliveryId: delivery.deliveryId,
          channelId: delivery.channelId,
          threadTs: delivery.threadTs,
          kind: delivery.kind,
        });
        if (claim.state === "succeeded") return;
        const replies = yield* runtime.slack.replies({
          token: credential.token,
          channelId: delivery.channelId,
          threadTs: delivery.threadTs,
          includeAllMetadata: true,
        });
        const reconciled = hasDeliveryMetadata(replies, delivery.deliveryId);
        const postedTs =
          reconciled ??
          (yield* runtime.slack.postToThread({
            token: credential.token,
            channelId: delivery.channelId,
            threadTs: delivery.threadTs,
            text: delivery.text,
            metadata: {
              eventType: "pathway_delivery",
              eventPayload: { delivery_id: delivery.deliveryId },
            },
          })).messageTs;
        yield* runtime.backend.completeDelivery({
          companyId: runtime.companyId,
          integrationId: integration.id,
          generation,
          deliveryId: delivery.deliveryId,
          claimGeneration: claim.claimGeneration,
          slackMessageTs: postedTs,
        });
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            firstError ??= `Slack delivery: ${error instanceof Error ? error.message : String(error)}`;
          }),
        ),
      );
      yield* pass;
    }
    yield* runtime.backend.updateHealth({
      companyId: runtime.companyId,
      integrationId: integration.id,
      generation,
      lastPollAt: firstError === null ? runtime.now() : null,
      error: firstError,
    });
  }
});

export const startCompanySlackCoordinator = Effect.fn("cloud.company_slack.start")(function* () {
  const vitest = yield* Config.string("VITEST").pipe(Config.withDefault(""));
  if (vitest.length > 0) {
    markCompanyIntegrationAuthorityResolved();
    markCompanyAutomationAuthorityResolved();
    return null;
  }
  const config = yield* resolveCloudSyncConfig;
  if (config._tag !== "Configured") {
    markCompanyIntegrationAuthorityResolved();
    markCompanyAutomationAuthorityResolved();
    return null;
  }
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  if ((yield* readCloudSyncLink(secrets)) === null) {
    markCompanyIntegrationAuthorityResolved();
    markCompanyAutomationAuthorityResolved();
    return null;
  }
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const tokens = yield* makeCloudSyncTokenProvider({ environmentId, secrets });
  const backend = yield* makeCompanySlackBackend({ convexUrl: config.settings.convexUrl, tokens });
  const slack = yield* SlackApiClient;
  const automation = yield* makeCompanyAutomationExecutor();
  const providerRegistry = yield* ProviderInstanceRegistry;
  const readProviders = () =>
    providerRegistry.listInstances.pipe(
      Effect.flatMap((instances) =>
        Effect.forEach(instances, (instance) =>
          instance.snapshot.getSnapshot.pipe(
            Effect.map((snapshot) => ({
              instanceId: instance.instanceId,
              driverKind: instance.driverKind,
              enabled: instance.enabled,
              available: snapshot.installed && snapshot.status !== "error",
              modelIds: snapshot.models.map((model) => model.slug),
            })),
          ),
        ),
      ),
    );
  const runtime: CompanySlackRuntime = {
    companyId: config.settings.companyId,
    environmentId,
    backend,
    slack,
    now: Date.now,
    automation,
    readProviders,
  };
  return yield* Effect.all([
    forkParkedFiber(
      runCompanySlackCycle(runtime).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.void
            : Effect.logWarning("Company Slack coordinator cycle failed", { cause }),
        ),
        Effect.andThen(Effect.sleep(Duration.millis(COMPANY_SLACK_POLL_INTERVAL_MS))),
        Effect.forever,
      ),
    ),
    forkParkedFiber(
      runCompanyAutomationCycle(runtime).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.void
            : Effect.logWarning("Company automation cycle failed", { cause }),
        ),
        Effect.andThen(Effect.sleep(Duration.millis(COMPANY_SLACK_POLL_INTERVAL_MS))),
        Effect.forever,
      ),
    ),
  ]);
});

export const companySlackCoordinatorLayer = () =>
  Layer.effectDiscard(
    startCompanySlackCoordinator().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Company Slack coordinator failed to start", { cause }),
      ),
    ),
  );
