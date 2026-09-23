/**
 * The Computer tools as the MCP endpoint serves them: the catalog, the caller
 * context each call reads, and the Pathway-owned approval path (ADR 0048).
 *
 * Tools are advertised only to a credential holding the `computer`
 * capability. Every call naming a Computer tool is answered here, before the
 * SDK: a caller without the capability gets `capability_denied` and the chat
 * gets one "Computer control is off" notice, instead of the SDK's opaque
 * unknown-tool error.
 *
 * @module mcp/computerMcpTools
 */
import {
  CommandId,
  ComputerAutonomy,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  resolveComputerAutonomy,
  ThreadId,
  TurnItemId,
} from "@spiritdevs/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  ComputerApprovalGate,
  ComputerApprovalPublishError,
  computerApprovalPolicy,
} from "../computer/ComputerApprovalGate.ts";
import { ComputerService } from "../computer/Services/ComputerService.ts";
import { computerSpaceDesignationForMessages } from "../computer/computerSpaceDesignation.ts";
import {
  computerForegroundAuthorizationForMessages,
  type ComputerVisibleUseMessage,
} from "../computer/computerVisibleUse.ts";
import { EventSinkV2 } from "../orchestration-v2/EventSink.ts";
import { IdAllocatorV2 } from "../orchestration-v2/IdAllocator.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProjectionProjectRepository } from "../persistence/Services/ProjectionProjects.ts";
import { SCHEDULED_TASK_MESSAGE_ID_PREFIX } from "../scheduledTasks/ScheduledTaskService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import { makeComputerBrowserTools } from "./toolkits/computer/computerBrowserTools.ts";
import { COMPUTER_CONTROL_CAPABILITY } from "./toolkits/computer/computerToolErrors.ts";
import { isPathwayComputerToolFamilyName } from "./toolkits/computer/computerToolPermission.ts";
import { makeComputerTools } from "./toolkits/computer/computerTools.ts";
import {
  type ComputerAuthorizeAction,
  ComputerToolError,
  computerToolErrorResult,
  type JsonRpcId,
  type McpToolCallResult,
  mcpToolResultError,
  type ToolContext,
  type ToolEntry,
} from "./toolkits/computer/toolRuntime.ts";

/** A run the caller's Computer calls may still act for. */
const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2Run["status"]> = new Set([
  "starting",
  "running",
  "waiting",
]);

/** Typed text never reaches a card; the agent's own words stay in the transcript. */
const HIDDEN_DETAIL_KEYS = new Set(["text", "value", "prompt_text"]);

const NOTICE_MEMORY = 512;

/** The app a browser tool drives, for once-per-app consent: the driver-owned Chromium. */
const COMPUTER_BROWSER_APP = "Browser";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export interface ComputerMcpTools {
  /** Tools a `computer` credential sees in `tools/list`. */
  readonly advertised: ReadonlyArray<ToolEntry>;
  /** Whether this endpoint answers a call to `name` itself. */
  readonly handles: (name: string) => boolean;
  /** Answers one `tools/call`; `undefined` leaves an unknown name to the SDK. */
  readonly call: (input: {
    readonly invocation: McpInvocationScope;
    readonly name: string;
    readonly args: Record<string, unknown>;
    readonly jsonRpcRequestId: JsonRpcId;
  }) => Effect.Effect<McpToolCallResult | undefined>;
}

/** The newest run of the thread that is still acting, if any. */
export function activeComputerRun(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2Run | undefined {
  return projection.runs.findLast((run) => ACTIVE_RUN_STATUSES.has(run.status));
}

/** Scheduled runs and subagents act with nobody watching; ADR 0043 gives them the ceiling alone. */
export function isUnattendedComputerCaller(projection: OrchestrationV2ThreadProjection): boolean {
  if (projection.thread.lineage.relationshipToParent === "subagent") return true;
  const run = activeComputerRun(projection);
  return run !== undefined && run.userMessageId.startsWith(SCHEDULED_TASK_MESSAGE_ID_PREFIX);
}

/** Pathway messages in the shape the visible-use and Space resolvers read. */
export function computerVisibleUseMessages(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
): ReadonlyArray<ComputerVisibleUseMessage> {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    streaming: message.streaming,
    dispatchOrigin:
      message.createdBy === "user"
        ? "user"
        : message.createdBy === "agent"
          ? "agent"
          : "automation",
    attachments: message.attachments,
  }));
}

/** Call arguments a card may show: typed text is withheld. */
export function computerApprovalDetail(args: Record<string, unknown>): string | undefined {
  const shown = Object.fromEntries(
    Object.entries(args).filter(([key]) => !HIDDEN_DETAIL_KEYS.has(key)),
  );
  return Object.keys(shown).length === 0 ? undefined : encodeJson(shown);
}

/** Remembers the last few keys, so a notice posts once per turn and reason. */
function recentKeys() {
  const keys = new Set<string>();
  return (key: string): boolean => {
    if (keys.has(key)) return false;
    keys.add(key);
    if (keys.size > NOTICE_MEMORY) keys.delete(keys.values().next().value!);
    return true;
  };
}

const unattendedNotAllowed = new ComputerToolError({
  code: "unattended_not_allowed",
  message:
    "Scheduled tasks and subagents may use Computer only when this environment allows full access. Nothing was sent.",
});

const policyTightened = new ComputerToolError({
  code: "computer_policy_changed",
  message:
    "Computer's approval policy became stricter after this call was approved, so nothing was sent. Call again to ask under the new policy.",
});

const isStricter = (autonomy: ComputerAutonomy, than: ComputerAutonomy) =>
  ComputerAutonomy.literals.indexOf(autonomy) < ComputerAutonomy.literals.indexOf(than);

const capabilityDenied = (name: string) =>
  computerToolErrorResult(
    new ComputerToolError({
      code: "capability_denied",
      message: `This provider session is not authorized for ${name}. Computer control is off for this chat; the user can turn it on and start a new turn.`,
      details: { requiredCapability: COMPUTER_CONTROL_CAPABILITY },
    }),
  );

/**
 * Builds the Computer tool surface for this server. Empty, answering nothing,
 * when the host can never drive a desktop.
 */
export const makeComputerMcpTools = Effect.gen(function* () {
  const computer = yield* Effect.serviceOption(ComputerService);
  if (Option.isNone(computer) || !computer.value.supported) {
    return {
      advertised: [],
      handles: () => false,
      call: () => Effect.succeed(undefined),
    } satisfies ComputerMcpTools;
  }
  const manager = computer.value.manager;
  const gate = yield* ComputerApprovalGate;
  const projections = yield* ProjectionStoreV2;
  const eventSink = yield* EventSinkV2;
  const ids = yield* IdAllocatorV2;
  const settings = yield* ServerSettingsService;
  const projects = yield* ProjectionProjectRepository;

  const projectionOf = (threadId: string) =>
    projections.getThreadProjection(ThreadId.make(threadId)).pipe(Effect.option);

  const messagesOf = (context: ToolContext) =>
    projectionOf(context.callerThreadId).pipe(
      Effect.map((projection) =>
        Option.isNone(projection) ? [] : computerVisibleUseMessages(projection.value.messages),
      ),
    );

  const firstNotice = recentKeys();
  /** One completed `dynamic_tool` row on the caller's run, for the human. */
  const postNotice = (
    context: ToolContext,
    key: string,
    toolName: string,
    title: string,
    input: Record<string, unknown>,
  ) =>
    Effect.gen(function* () {
      const runId = context.callerTurnId;
      if (runId === null || !firstNotice(`${context.callerThreadId}:${runId}:${key}`)) return;
      const projection = yield* projectionOf(context.callerThreadId);
      if (Option.isNone(projection)) return;
      const run = projection.value.runs.find((candidate) => candidate.id === runId);
      if (run === undefined) return;
      const threadId = ThreadId.make(context.callerThreadId);
      const now = yield* DateTime.now;
      const commandId = CommandId.make(`command:computer-notice:${runId}:${key}`);
      const event = ids.allocate.event({ threadId, commandId });
      yield* eventSink.write({
        commandId,
        events: [
          {
            id: yield* event,
            type: "turn-item.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: {
              id: TurnItemId.make(`turn-item:computer-notice:${runId}:${key}`),
              threadId,
              runId: run.id,
              nodeId: null,
              providerThreadId: run.providerThreadId,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: Math.max(0, ...projection.value.turnItems.map((item) => item.ordinal)) + 1,
              status: "completed",
              title,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "dynamic_tool",
              toolName,
              input,
            },
          },
        ],
      });
    }).pipe(Effect.ignore({ log: true }));

  /**
   * The autonomy the caller acts under now (ADR 0043): the environment ceiling
   * bounds the thread's own mode, and alone governs unattended callers. None
   * when the ceiling keeps unattended callers off the desktop.
   */
  const autonomyOf = (projection: Option.Option<OrchestrationV2ThreadProjection>) =>
    Effect.gen(function* () {
      const { computer: policy } = yield* settings.getSettings.pipe(Effect.orDie);
      if (Option.isSome(projection) && isUnattendedComputerCaller(projection.value)) {
        return computerApprovalPolicy(policy.autonomy).unattended
          ? Option.some(policy.autonomy)
          : Option.none();
      }
      return Option.some(
        resolveComputerAutonomy(
          policy.autonomy,
          Option.isNone(projection) ? null : projection.value.thread.runtimeMode,
        ),
      );
    });
  const callerAutonomy = (threadId: string) =>
    projectionOf(threadId).pipe(Effect.flatMap(autonomyOf));

  /** The autonomy each call was authorized under; its dispatch refuses a stricter one. */
  const authorizedUnder = new WeakMap<ToolContext, ComputerAutonomy>();

  const authorizeAction: ComputerAuthorizeAction = (name, args, context) =>
    Effect.gen(function* () {
      yield* context
        .assertCallerTurnActive()
        .pipe(
          Effect.mapError(
            (error) => new ComputerApprovalPublishError({ message: error.message, cause: error }),
          ),
        );
      const resolved = yield* callerAutonomy(context.callerThreadId);
      if (Option.isNone(resolved)) return "denied";
      const autonomy = resolved.value;
      authorizedUnder.set(context, autonomy);
      const turnId = context.callerTurnId ?? undefined;
      const detail = computerApprovalDetail(args);
      const call = {
        threadId: context.callerThreadId,
        turnId,
        callKey: `${name}:${encodeJson(args)}`,
        toolName: name,
        detail,
      };
      if (name === "computer_read_clipboard") {
        return yield* gate.authorizeClipboardRead({ ...call, autonomy });
      }
      const outcome = yield* gate.authorizeAction({ ...call, autonomy });
      if (outcome !== "approved" || turnId === undefined) return outcome;
      // The desktop refuses input for an app the turn may not drive yet; the
      // next call asks for it here. Browser tools and a declared `app` ask up front.
      const declared = name.startsWith("computer_browser_")
        ? COMPUTER_BROWSER_APP
        : typeof args.app === "string"
          ? args.app.trim()
          : "";
      if (declared.length > 0) gate.appAllowed(context.callerThreadId, turnId, declared);
      for (const app of gate.takeWantedApps(context.callerThreadId, turnId)) {
        const appOutcome = yield* gate.authorizeApp({
          threadId: context.callerThreadId,
          turnId,
          toolName: name,
          detail,
          app,
          autonomy,
        });
        if (appOutcome !== "approved") return appOutcome;
      }
      return outcome;
    });

  // Full access allows foreground outright; below it only the task's own request does.
  // Both toolkits read a resolver defect as "not asked"; interruption stays interruption.
  const resolveForegroundAuthorization = (context: ToolContext) =>
    Effect.gen(function* () {
      const autonomy = yield* callerAutonomy(context.callerThreadId);
      if (
        Option.isSome(autonomy) &&
        computerApprovalPolicy(autonomy.value).foreground === "allowed"
      ) {
        return { userRequestedVisibleUse: true };
      }
      return computerForegroundAuthorizationForMessages(yield* messagesOf(context), {
        knownAppNames: manager.observedAppNames(),
      });
    });

  const resolveSpaceDesignation = (context: ToolContext) =>
    messagesOf(context).pipe(Effect.map(computerSpaceDesignationForMessages));

  const resolveWorkspaceRoot = (context: ToolContext) =>
    Effect.gen(function* () {
      const projection = yield* projectionOf(context.callerThreadId);
      if (Option.isNone(projection)) return null;
      const { thread } = projection.value;
      if (thread.worktreePath !== null) return thread.worktreePath;
      if (thread.projectId === null) return null;
      const project = yield* projects
        .getById({ projectId: thread.projectId })
        .pipe(Effect.option, Effect.map(Option.flatten));
      return Option.isSome(project) ? project.value.workspaceRoot : null;
    });

  const browserTools = manager.supportsBrowser
    ? yield* makeComputerBrowserTools({
        manager,
        authorizeAction,
        resolveForegroundAuthorization,
        resolveWorkspaceRoot,
      })
    : [];
  const desktopTools = makeComputerTools({
    manager,
    relatedTools: browserTools,
    authorizeAction,
    resolveForegroundAuthorization,
    resolveSpaceDesignation,
    onSetupRequired: ({ toolName, missing, buildSignature, bundleId, context }) =>
      postNotice(
        context,
        `setup:${[...missing].toSorted().join(",")}`,
        "computer_setup_required",
        "Computer control needs setup",
        {
          toolName,
          missing,
          ...(buildSignature === undefined ? {} : { buildSignature }),
          ...(bundleId === undefined ? {} : { bundleId }),
        },
      ),
  });
  const tools = new Map(
    [...desktopTools, ...browserTools].map((entry) => [entry.definition.name, entry] as const),
  );

  const contextFor = Effect.fn("ComputerMcpTools.contextFor")(function* (
    invocation: McpInvocationScope,
    jsonRpcRequestId: JsonRpcId,
  ) {
    const projection = yield* projectionOf(invocation.threadId);
    const run = Option.isNone(projection) ? undefined : activeComputerRun(projection.value);
    const callerTurnId = run?.id ?? null;
    const context: ToolContext = {
      callerThreadId: invocation.threadId,
      callerThreadLabel: Option.isNone(projection) ? null : projection.value.thread.title,
      callerSessionKey: invocation.providerSessionId,
      callerProvider: invocation.providerDriverKind,
      callerCapabilities: invocation.capabilities,
      callerTurnId,
      // Re-read at each check: a call that waited on the desktop or a card
      // must not act for a turn that ended meanwhile, nor under a policy
      // that became stricter after the call was authorized.
      assertCallerTurnActive: () =>
        Effect.gen(function* () {
          const current = yield* projectionOf(invocation.threadId);
          const active = Option.isNone(current) ? undefined : activeComputerRun(current.value);
          if (callerTurnId === null || active?.id !== callerTurnId) {
            return yield* new ComputerToolError({
              code: "caller_turn_inactive",
              message: "The turn that made this call is no longer active, so Computer refused it.",
            });
          }
          const autonomy = yield* autonomyOf(current);
          if (Option.isNone(autonomy)) return yield* unattendedNotAllowed;
          const authorized = authorizedUnder.get(context);
          if (authorized !== undefined && isStricter(autonomy.value, authorized)) {
            return yield* policyTightened;
          }
        }),
      jsonRpcRequestId,
    };
    return context;
  });

  // `handles` admits only catalog and Computer-family names.
  const call: ComputerMcpTools["call"] = ({ invocation, name, args, jsonRpcRequestId }) =>
    Effect.gen(function* () {
      const entry = tools.get(name);
      const permitted = invocation.capabilities.has(
        entry?.requiredCapability ?? COMPUTER_CONTROL_CAPABILITY,
      );
      // A permitted caller naming a tool this host lacks gets the SDK's unknown tool.
      if (entry === undefined && permitted) return undefined;
      const context = yield* contextFor(invocation, jsonRpcRequestId);
      if (!permitted || entry?.requiresActiveTurn === true) {
        const inactive = yield* context.assertCallerTurnActive().pipe(Effect.flip, Effect.option);
        if (Option.isSome(inactive)) return computerToolErrorResult(inactive.value);
      }
      if (!permitted || entry === undefined) {
        yield* postNotice(
          context,
          `denied:${name}`,
          "computer_capability_denied",
          "Computer control is off for this chat",
          { toolName: name },
        );
        return capabilityDenied(name);
      }
      if (Option.isNone(yield* callerAutonomy(invocation.threadId))) {
        return computerToolErrorResult(unattendedNotAllowed);
      }
      return yield* entry
        .handler(args, context)
        .pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.failCause(cause)
              : Effect.succeed(mcpToolResultError(`${name} failed unexpectedly.`)),
          ),
        );
    });

  return {
    advertised: [...tools.values()].filter((entry) => entry.discoveryOnly !== true),
    handles: (name) => tools.has(name) || isPathwayComputerToolFamilyName(name),
    call,
  } satisfies ComputerMcpTools;
});
