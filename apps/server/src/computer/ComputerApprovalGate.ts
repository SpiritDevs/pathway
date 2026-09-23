/**
 * Pathway-owned Computer consent (ADR 0048).
 *
 * The Computer MCP toolkit asks this gate before a gated call. The gate posts
 * one pending-approval card through `ComputerApprovalRequester` (implemented
 * by the thread layer) and waits a bounded time for the user. When the bound
 * expires the call gets `"pending"`: nothing was sent, the card stays open,
 * and the decision applies to the next identical call from that turn. A
 * pending result is not an attempted action.
 *
 * Consent is scoped to one live turn. Task and app grants cover every call of
 * the turn; per-call approvals (supervised mutations, clipboard reads) cover
 * one call. Stop, turn boundaries and restarts discard open prompts through
 * `cancelThread`. How much is asked at all is `computerApprovalPolicy` of the
 * thread's resolved autonomy (ADR 0043); the denylist, Stop/Escape and the
 * audit log apply regardless and are not this gate's concern.
 *
 * @module computer/ComputerApprovalGate
 */
import type { ComputerAutonomy, ProviderApprovalDecision } from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

/** Rejection when no more consent prompts fit, global or for one chat. */
export const COMPUTER_APPROVAL_QUEUE_FULL_CODE = "approval_queue_full";
export const COMPUTER_APPROVAL_QUEUE_GLOBAL_LIMIT = 128;
export const COMPUTER_APPROVAL_QUEUE_THREAD_LIMIT = 8;
/** An unanswered card is withdrawn after this long. */
export const COMPUTER_APPROVAL_TIMEOUT = Duration.minutes(5);
/**
 * How long one tool call waits for a decision before returning `"pending"`.
 * Kept below the shortest known provider MCP tool timeout (Codex's 60 s
 * default) so the provider never abandons the call first.
 */
export const COMPUTER_APPROVAL_WAIT_BOUND = Duration.seconds(45);

export class ComputerApprovalQueueFullError extends Schema.TaggedErrorClass<ComputerApprovalQueueFullError>()(
  "ComputerApprovalQueueFullError",
  { scope: Schema.Literals(["thread", "global"]) },
) {
  readonly code = COMPUTER_APPROVAL_QUEUE_FULL_CODE;
  readonly retryable = true;

  override get message(): string {
    return this.scope === "thread"
      ? "Too many computer approvals are waiting for this chat; try again once an earlier prompt settles."
      : "Too many computer approvals are waiting.";
  }
}

/** The approval card could not be posted, so nobody could have answered it. */
export class ComputerApprovalPublishError extends Schema.TaggedErrorClass<ComputerApprovalPublishError>()(
  "ComputerApprovalPublishError",
  { message: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

/**
 * What an answer authorizes: this one call, every routine call of the task
 * (turn), or one more application within the task.
 */
export type ComputerApprovalScope = "call" | "task" | "app";

/** One approval card, as the requester posts it. */
export interface ComputerApprovalPrompt {
  readonly requestId: string;
  readonly threadId: string;
  readonly turnId: string | undefined;
  readonly scope: ComputerApprovalScope;
  readonly toolName: string;
  /** Display-safe call details (no typed text). */
  readonly detail?: string | undefined;
  /** The application an `"app"` prompt asks about. */
  readonly app?: string | undefined;
}

/**
 * Posts and settles approval cards on the thread. P4 implements this over
 * orchestration activities; the gate never renders anything itself.
 */
export interface ComputerApprovalRequesterShape {
  /** Posts the pending card. A failure fails every call waiting on it. */
  readonly open: (
    prompt: ComputerApprovalPrompt,
  ) => Effect.Effect<void, ComputerApprovalPublishError>;
  /**
   * Marks the card settled with the decision, or withdrawn with `"cancel"`.
   * Best effort: a failure here never changes the decision.
   */
  readonly resolve: (
    prompt: ComputerApprovalPrompt,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<void, ComputerApprovalPublishError>;
}

export class ComputerApprovalRequester extends Context.Service<
  ComputerApprovalRequester,
  ComputerApprovalRequesterShape
>()("@spiritdevs/pathway/computer/ComputerApprovalGate/ComputerApprovalRequester") {}

/**
 * `"pending"` means the wait bound expired: no input may be sent, and the
 * caller should tell the agent to call again once the user has answered.
 */
export type ComputerApprovalOutcome = "approved" | "denied" | "pending";

export type ComputerApprovalError = ComputerApprovalQueueFullError | ComputerApprovalPublishError;

/** What a resolved autonomy level asks the user (ADR 0043). */
export interface ComputerApprovalPolicy {
  readonly mutation: "every-call" | "once-per-task" | "none";
  /** Another application beyond those the task already drives. */
  readonly extraApp: "once-per-app" | "none";
  /** Foreground delivery otherwise needs the user's explicit request in chat. */
  readonly foreground: "explicit-request" | "allowed";
  readonly clipboardRead: "ask" | "allowed";
  /** Scheduled tasks and subagents may use Computer. */
  readonly unattended: boolean;
}

export function computerApprovalPolicy(autonomy: ComputerAutonomy): ComputerApprovalPolicy {
  switch (autonomy) {
    case "supervised":
      return {
        mutation: "every-call",
        extraApp: "once-per-app",
        foreground: "explicit-request",
        clipboardRead: "ask",
        unattended: false,
      };
    case "per-task":
      return {
        mutation: "once-per-task",
        extraApp: "once-per-app",
        foreground: "explicit-request",
        clipboardRead: "ask",
        unattended: false,
      };
    case "auto":
      return {
        mutation: "none",
        extraApp: "none",
        foreground: "explicit-request",
        clipboardRead: "ask",
        unattended: false,
      };
    case "full-access":
      return {
        mutation: "none",
        extraApp: "none",
        foreground: "allowed",
        clipboardRead: "allowed",
        unattended: true,
      };
  }
}

interface CallInput {
  readonly threadId: string;
  readonly turnId?: string | undefined;
  /**
   * Identifies the call (tool name plus canonical arguments). A decision that
   * arrives after the wait bound applies to the next call with the same key.
   */
  readonly callKey: string;
  readonly toolName: string;
  readonly detail?: string | undefined;
}

interface TaskInput {
  readonly threadId: string;
  readonly turnId: string;
  readonly toolName: string;
  readonly detail?: string | undefined;
}

export interface ComputerApprovalGateShape {
  /** One consent for this call only. Interrupting the caller withdraws the card. */
  readonly request: (
    input: CallInput,
  ) => Effect.Effect<ComputerApprovalOutcome, ComputerApprovalError>;
  /**
   * One consent for routine actions in the exact active turn, shared by
   * concurrent callers. Interrupting one caller leaves the card for the rest.
   */
  readonly requestTask: (
    input: TaskInput,
  ) => Effect.Effect<ComputerApprovalOutcome, ComputerApprovalError>;
  /** One consent per application within the turn. */
  readonly requestApp: (
    input: TaskInput & { readonly app: string },
  ) => Effect.Effect<ComputerApprovalOutcome, ComputerApprovalError>;
  /** A mutating call, asked as the autonomy level requires. */
  readonly authorizeAction: (
    input: CallInput & { readonly autonomy: ComputerAutonomy },
  ) => Effect.Effect<ComputerApprovalOutcome, ComputerApprovalError>;
  /** Driving an application the task has not driven yet. */
  readonly authorizeApp: (
    input: TaskInput & { readonly app: string; readonly autonomy: ComputerAutonomy },
  ) => Effect.Effect<ComputerApprovalOutcome, ComputerApprovalError>;
  readonly authorizeClipboardRead: (
    input: CallInput & { readonly autonomy: ComputerAutonomy },
  ) => Effect.Effect<ComputerApprovalOutcome, ComputerApprovalError>;
  /**
   * Routes a user decision. False when the card is not open for that thread.
   * Session-wide approval is unavailable here, so `acceptForSession` declines.
   */
  readonly respond: (
    threadId: string,
    requestId: string,
    decision: ProviderApprovalDecision,
  ) => Effect.Effect<boolean>;
  /** Drops grants and withdraws cards for the thread, or only for one turn. */
  readonly cancelThread: (threadId: string, turnId?: string) => Effect.Effect<void>;
  /**
   * A desktop interruption (screen lock, sleep, session switch) revokes every
   * standing grant, so consent given before it cannot authorize the desktop
   * after it. Declines stay declined, and open cards stay open: an answer to
   * one can only postdate the interruption, so it is the re-auth itself.
   */
  readonly revokeTaskGrants: Effect.Effect<void>;
}

export class ComputerApprovalGate extends Context.Service<
  ComputerApprovalGate,
  ComputerApprovalGateShape
>()("@spiritdevs/pathway/computer/ComputerApprovalGate") {}

interface Grant {
  granted?: boolean;
  prompt?: Prompt | undefined;
}

interface TaskGrants {
  readonly turnId: string;
  readonly grants: Map<string, Grant>;
}

interface Prompt {
  readonly info: ComputerApprovalPrompt;
  readonly answer: Deferred.Deferred<ProviderApprovalDecision, ComputerApprovalPublishError>;
  /** Per-call prompts only. */
  readonly callKey?: string | undefined;
  /** Task and app prompts only. */
  readonly grant?: Grant | undefined;
  /** A per-call prompt with a live waiter; detached ones wait for the next identical call. */
  attached: boolean;
  timer?: Fiber.Fiber<void> | undefined;
}

export interface ComputerApprovalGateOptions {
  readonly waitBound?: Duration.Input;
  readonly timeout?: Duration.Input;
}

export const make = Effect.fn("ComputerApprovalGate.make")(function* (
  options: ComputerApprovalGateOptions = {},
) {
  const requester = yield* ComputerApprovalRequester;
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;
  const waitBound = options.waitBound ?? COMPUTER_APPROVAL_WAIT_BOUND;
  const timeout = options.timeout ?? COMPUTER_APPROVAL_TIMEOUT;

  /** Open cards, plus per-call answers not yet consumed by their call. */
  const prompts = new Map<string, Prompt>();
  const tasks = new Map<string, TaskGrants>();

  const remove = (prompt: Prompt) => {
    if (prompts.get(prompt.info.requestId) === prompt) prompts.delete(prompt.info.requestId);
    if (prompt.grant?.prompt === prompt) prompt.grant.prompt = undefined;
    prompt.timer?.interruptUnsafe();
  };

  /** Best-effort dismissal: a hung or failed publish must not hold anyone. */
  const dismiss = (prompt: Prompt, decision: ProviderApprovalDecision) =>
    requester
      .resolve(prompt.info, decision)
      .pipe(Effect.ignore, Effect.forkIn(scope), Effect.asVoid);

  const settle = (prompt: Prompt, decision: ProviderApprovalDecision) =>
    Effect.suspend(() => {
      if (!Deferred.doneUnsafe(prompt.answer, Effect.succeed(decision))) return Effect.void;
      // Per-call answers wait for their call; everything else is done now.
      if (decision === "cancel" || prompt.callKey === undefined) remove(prompt);
      return dismiss(prompt, decision);
    });

  const cancel = (prompt: Prompt) =>
    Effect.suspend(() => {
      remove(prompt);
      return settle(prompt, "cancel");
    });

  const fail = (prompt: Prompt, error: ComputerApprovalPublishError) =>
    Effect.suspend(() => {
      remove(prompt);
      if (!Deferred.doneUnsafe(prompt.answer, Effect.fail(error))) return Effect.void;
      return dismiss(prompt, "cancel");
    });

  const open = Effect.fnUntraced(function* (
    info: Omit<ComputerApprovalPrompt, "requestId">,
    owner: { readonly callKey: string } | { readonly grant: Grant },
  ) {
    // A stuck turn must not starve every other chat: each thread gets a small
    // cap inside the shared one, and both refuse retryably so the model waits
    // instead of treating a full queue as a denial.
    let threadPending = 0;
    for (const pending of prompts.values()) {
      if (pending.info.threadId === info.threadId) threadPending += 1;
    }
    if (threadPending >= COMPUTER_APPROVAL_QUEUE_THREAD_LIMIT) {
      return yield* new ComputerApprovalQueueFullError({ scope: "thread" });
    }
    if (prompts.size >= COMPUTER_APPROVAL_QUEUE_GLOBAL_LIMIT) {
      return yield* new ComputerApprovalQueueFullError({ scope: "global" });
    }
    const requestId = `computer:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;
    const prompt: Prompt = {
      info: { ...info, requestId },
      answer: Deferred.makeUnsafe(),
      ...owner,
      attached: false,
    };
    prompts.set(requestId, prompt);
    if ("grant" in owner) owner.grant.prompt = prompt;
    prompt.timer = yield* Effect.sleep(timeout).pipe(
      Effect.andThen(
        Effect.suspend(() => {
          // The timer must not interrupt itself on the way out.
          prompt.timer = undefined;
          return cancel(prompt);
        }),
      ),
      Effect.forkIn(scope),
    );
    // Publishing is not the decision path: an answer or cancel that lands
    // while the card is still being posted settles the call regardless.
    yield* requester.open(prompt.info).pipe(
      Effect.catch((error) => fail(prompt, error)),
      Effect.forkIn(scope, { startImmediately: true }),
    );
    return prompt;
  });

  const awaitAnswer = (prompt: Prompt) =>
    Deferred.await(prompt.answer).pipe(Effect.timeoutOption(waitBound));

  const request: ComputerApprovalGateShape["request"] = (input) =>
    Effect.uninterruptibleMask(
      Effect.fnUntraced(function* (restore) {
        let prompt: Prompt | undefined;
        for (const candidate of prompts.values()) {
          if (
            !candidate.attached &&
            candidate.callKey === input.callKey &&
            candidate.info.threadId === input.threadId &&
            candidate.info.turnId === input.turnId
          ) {
            prompt = candidate;
            break;
          }
        }
        prompt ??= yield* open(
          {
            threadId: input.threadId,
            turnId: input.turnId,
            scope: "call",
            toolName: input.toolName,
            detail: input.detail,
          },
          { callKey: input.callKey },
        );
        const current = prompt;
        current.attached = true;
        const decision = yield* restore(awaitAnswer(current)).pipe(
          Effect.onInterrupt(() => cancel(current)),
          Effect.onError(() => Effect.sync(() => remove(current))),
        );
        if (Option.isNone(decision)) {
          current.attached = false;
          return "pending" as const;
        }
        remove(current);
        return decision.value === "accept" ? ("approved" as const) : ("denied" as const);
      }),
    );

  const cancelThread: ComputerApprovalGateShape["cancelThread"] = (threadId, turnId) =>
    Effect.suspend(() => {
      const task = tasks.get(threadId);
      if (turnId === undefined || task?.turnId === turnId) tasks.delete(threadId);
      const cancelled = [...prompts.values()].filter(
        (prompt) =>
          prompt.info.threadId === threadId &&
          (turnId === undefined || prompt.info.turnId === turnId),
      );
      return Effect.forEach(cancelled, cancel, { discard: true });
    });

  const requestGrant = Effect.fnUntraced(function* (
    key: string,
    input: TaskInput & { readonly app?: string },
  ) {
    let task = tasks.get(input.threadId);
    if (task?.turnId !== input.turnId) {
      yield* cancelThread(input.threadId);
      task = { turnId: input.turnId, grants: new Map() };
      tasks.set(input.threadId, task);
    }
    const current = task;
    let grant = current.grants.get(key);
    if (grant === undefined) {
      grant = {};
      current.grants.set(key, grant);
    }
    const slot = grant;
    if (slot.granted !== undefined) return slot.granted ? "approved" : "denied";
    const prompt =
      slot.prompt ??
      (yield* open(
        {
          threadId: input.threadId,
          turnId: input.turnId,
          scope: input.app === undefined ? "task" : "app",
          toolName: input.toolName,
          detail: input.detail,
          app: input.app,
        },
        { grant: slot },
      ));
    // Only the gate cancels a shared card; a waiter that leaves just stops waiting.
    const decision = yield* awaitAnswer(prompt);
    if (Option.isNone(decision)) return "pending" as const;
    // Stop may race an accept: consent counts only while the turn still holds it.
    return tasks.get(input.threadId) === current &&
      current.grants.get(key) === slot &&
      slot.granted === true
      ? ("approved" as const)
      : ("denied" as const);
  });

  const requestTask: ComputerApprovalGateShape["requestTask"] = (input) =>
    requestGrant("task", input);

  const requestApp: ComputerApprovalGateShape["requestApp"] = (input) =>
    requestGrant(`app:${input.app.trim().toLowerCase()}`, input);

  const approved = Effect.succeed("approved" as const);

  const authorizeAction: ComputerApprovalGateShape["authorizeAction"] = (input) => {
    const mode = computerApprovalPolicy(input.autonomy).mutation;
    if (mode === "none") return approved;
    return mode === "once-per-task" && input.turnId !== undefined
      ? requestTask({ ...input, turnId: input.turnId })
      : request(input);
  };

  const authorizeApp: ComputerApprovalGateShape["authorizeApp"] = (input) =>
    computerApprovalPolicy(input.autonomy).extraApp === "none" ? approved : requestApp(input);

  const authorizeClipboardRead: ComputerApprovalGateShape["authorizeClipboardRead"] = (input) =>
    computerApprovalPolicy(input.autonomy).clipboardRead === "allowed" ? approved : request(input);

  const respond: ComputerApprovalGateShape["respond"] = (threadId, requestId, decision) =>
    Effect.suspend(() => {
      const prompt = prompts.get(requestId);
      if (
        prompt === undefined ||
        prompt.info.threadId !== threadId ||
        Deferred.isDoneUnsafe(prompt.answer)
      ) {
        return Effect.succeed(false);
      }
      const effective = decision === "acceptForSession" ? "decline" : decision;
      if (prompt.grant?.prompt === prompt) prompt.grant.granted = effective === "accept";
      return settle(prompt, effective).pipe(Effect.as(true));
    });

  const revokeTaskGrants: ComputerApprovalGateShape["revokeTaskGrants"] = Effect.sync(() => {
    for (const task of tasks.values()) {
      for (const grant of task.grants.values()) {
        if (grant.granted === true) delete grant.granted;
      }
    }
  });

  return ComputerApprovalGate.of({
    request,
    requestTask,
    requestApp,
    authorizeAction,
    authorizeApp,
    authorizeClipboardRead,
    respond,
    cancelThread,
    revokeTaskGrants,
  });
});

export const layer = Layer.effect(ComputerApprovalGate, make());
