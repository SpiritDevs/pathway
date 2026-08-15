/**
 * Local SMTP capture client state — see `docs/plans/local-smtp-capture.md`.
 *
 * Capture belongs to the machine the server runs on, so every atom here is bound to
 * `primaryEnvironmentIdAtom` the way the issue tracker's are (`state/issues.ts:5`) rather than
 * being a per-environment family.
 *
 * Unlike the tracker, `email.stream` does not replay the mailbox: the contract says it carries
 * "diffs after the initial list/settings reads", so the snapshot is `email.list` and the stream is
 * an *invalidation signal* rather than a fold. That is why there is no message store in this
 * module — a captured message bumps {@link EmailStreamState.revision} and the list query refetches.
 * One round trip per inbound mail on a same-machine socket buys away a reconciliation problem
 * (cursor pagination, retention eviction, and scope filters all changing under an overlay) that a
 * refetch does not have.
 *
 * Inbox counts are the exception and are read straight off the stream: every event carries the
 * whole `inboxes` array, so the sidebar's unread badges land without waiting for the refetch.
 *
 * @module state/email
 */
import { useAtomValue } from "@effect/atom-react";
import { EnvironmentSupervisor } from "@spiritdevs/client-runtime/connection";
import { subscribe } from "@spiritdevs/client-runtime/rpc";
import {
  type AtomCommand,
  type AtomCommandResult,
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
  followStreamInEnvironment,
} from "@spiritdevs/client-runtime/state/runtime";
import {
  EMAIL_WS_METHODS,
  type CapturedEmailMessage,
  type CapturedEmailSummary,
  type EmailAnalyticsInput,
  type EmailAnalyticsResult,
  type EmailCaptureSettings,
  type EmailInboxScope,
  type EmailInboxSummary,
  type EmailListenerStatus,
  type EmailMessageId,
  type EmailSettingsSnapshot,
  type EmailStreamEvent,
  type EmailTriggerFiring,
  type EmailTriggerRule,
  type EnvironmentId,
  type ProjectId,
} from "@spiritdevs/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect, useEffectEvent } from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

// ── Stream state ───────────────────────────────────────────────────────

/**
 * What the client keeps folded from `email.stream`.
 *
 * `revision` counts events rather than describing them: every event in the union invalidates the
 * message list for at least one scope, and a list read is cheap enough that narrowing which scopes
 * moved would cost more code than it saves round trips.
 */
/** The loop-detection notice, kept whole so the toast can name the rule and the message. */
export type EmailTriggerAutoDisabledEvent = Extract<
  EmailStreamEvent,
  { readonly _tag: "EmailTriggerRuleAutoDisabled" }
>;

export interface EmailStreamState {
  readonly revision: number;
  /** Null until the first event; the list read answers for the inboxes until then. */
  readonly inboxes: ReadonlyArray<EmailInboxSummary> | null;
  /** The most recent capture, so a toast or an auto-select can name it without a diff of its own. */
  readonly lastCaptured: CapturedEmailSummary | null;
  /**
   * The server's latest settings push. Null until one arrives — the `email.getSettings` read
   * answers until then — so a reconnect falls back to a fresh read rather than to stale mutes.
   */
  readonly settings: EmailSettingsSnapshot | null;
  /** The last rule to trip loop detection, so its notice is visible from any route. */
  readonly lastAutoDisabledTrigger: EmailTriggerAutoDisabledEvent | null;
}

export const EMPTY_EMAIL_STREAM_STATE: EmailStreamState = {
  revision: 0,
  inboxes: null,
  lastCaptured: null,
  settings: null,
  lastAutoDisabledTrigger: null,
};

export function applyEmailStreamEvent(
  current: EmailStreamState,
  event: EmailStreamEvent,
): EmailStreamState {
  switch (event._tag) {
    case "EmailCaptured":
      return {
        ...current,
        revision: current.revision + 1,
        inboxes: event.inboxes,
        lastCaptured: event.message,
      };
    case "EmailReadStateChanged":
    case "EmailInboxCleared":
      return { ...current, revision: current.revision + 1, inboxes: event.inboxes };
    // Neither of the last two changes which messages exist, so the list query is left alone and
    // only the settings-shaped readers (mutes, the listener card, the loop notice) move.
    case "EmailSettingsChanged":
      return { ...current, settings: event.snapshot };
    case "EmailTriggerRuleAutoDisabled":
      return { ...current, lastAutoDisabledTrigger: event };
  }
}

/** Folds a chunk; the message list only refetches when `revision` moved. */
export function applyEmailStreamEvents(
  current: EmailStreamState,
  events: ReadonlyArray<EmailStreamEvent>,
): EmailStreamState {
  return events.reduce(applyEmailStreamEvent, current);
}

// ── Scopes ─────────────────────────────────────────────────────────────

export const ALL_EMAIL_SCOPE: EmailInboxScope = Object.freeze({ type: "all" });
export const UNASSIGNED_EMAIL_SCOPE: EmailInboxScope = Object.freeze({ type: "unassigned" });

/** A total, stable key for a scope — used for atom keys, map keys, and `===` on the URL param. */
export function emailScopeKey(scope: EmailInboxScope): string {
  return scope.type === "project" ? `project:${scope.projectId}` : scope.type;
}

export function emailScopesEqual(left: EmailInboxScope, right: EmailInboxScope): boolean {
  return emailScopeKey(left) === emailScopeKey(right);
}

export function findEmailInbox(
  inboxes: ReadonlyArray<EmailInboxSummary>,
  scope: EmailInboxScope,
): EmailInboxSummary | null {
  const key = emailScopeKey(scope);
  return inboxes.find((inbox) => emailScopeKey(inbox.scope) === key) ?? null;
}

/** The badge on the Email nav item: everything unread, wherever it was routed. */
export function totalEmailUnreadCount(inboxes: ReadonlyArray<EmailInboxSummary>): number {
  return findEmailInbox(inboxes, ALL_EMAIL_SCOPE)?.unreadCount ?? 0;
}

// ── Subscription ───────────────────────────────────────────────────────

/**
 * The connection generation, mirroring `state/issues.ts:568`. A reconnect has to start the fold
 * over: the stream carries no replay, so the inbox counts it left behind describe a mailbox this
 * client stopped watching.
 */
const emailConnectionGenerationAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom(
      followStreamInEnvironment(
        environmentId,
        Stream.unwrap(
          EnvironmentSupervisor.pipe(
            Effect.map((supervisor) =>
              SubscriptionRef.changes(supervisor.state).pipe(
                Stream.filterMap((state) =>
                  state.phase === "connected" ? Result.succeed(state.generation) : Result.failVoid,
                ),
                Stream.changes,
                Stream.map<number, number | null>((generation) => generation),
              ),
            ),
          ),
        ),
      ),
      { initialValue: null },
    )
    .pipe(Atom.withLabel(`web-email:connection-generation:${environmentId}`)),
);

/** Folded a chunk at a time so a burst of captures costs one refetch rather than one each. */
const emailChanges = createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:email:changes",
  subscribe: (_generation: number) =>
    subscribe(EMAIL_WS_METHODS.stream, {}).pipe(
      Stream.chunks,
      Stream.mapAccum(
        () => EMPTY_EMAIL_STREAM_STATE,
        (state: EmailStreamState, events: ReadonlyArray<EmailStreamEvent>) => {
          const next = applyEmailStreamEvents(state, events);
          return [next, [next]] as const;
        },
      ),
    ),
});

export type EmailStoreStatus = "disconnected" | "loading" | "ready" | "error";

export interface EmailStreamView {
  readonly state: EmailStreamState;
  readonly status: EmailStoreStatus;
}

const DISCONNECTED_EMAIL_STREAM_VIEW: EmailStreamView = {
  state: EMPTY_EMAIL_STREAM_STATE,
  status: "disconnected",
};

export const emailStreamViewAtom = Atom.make((get): EmailStreamView => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return DISCONNECTED_EMAIL_STREAM_VIEW;
  const generation = Option.getOrNull(
    AsyncResult.value(get(emailConnectionGenerationAtom(environmentId))),
  );
  if (generation === null) return DISCONNECTED_EMAIL_STREAM_VIEW;

  const changes = get(emailChanges({ environmentId, input: generation }));
  const state = Option.getOrElse(AsyncResult.value(changes), () => EMPTY_EMAIL_STREAM_STATE);
  if (AsyncResult.isFailure(changes)) return { state, status: "error" };
  return { state, status: AsyncResult.isSuccess(changes) ? "ready" : "loading" };
}).pipe(Atom.withLabel("web-email-stream-view"));

// ── Reads ──────────────────────────────────────────────────────────────

/**
 * The mailbox snapshot. Kept warm for a minute after the view closes so flipping between Email and
 * a thread does not refetch, and stale for five seconds so two components asking at once share one
 * request.
 */
const emailListQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:email:list",
  tag: EMAIL_WS_METHODS.list,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

const emailMessageQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:email:get",
  tag: EMAIL_WS_METHODS.get,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

/**
 * The capture settings and listener state. Read once and then kept current by the stream's
 * `EmailSettingsChanged`, which every write broadcasts — so a mute toggled on one client moves the
 * sidebar on the others without either of them polling.
 */
const emailSettingsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:email:settings",
  tag: EMAIL_WS_METHODS.getSettings,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

/**
 * The aggregate read behind the Analytics view. Same warmth as the mailbox snapshot: a scope or a
 * range flipped back and forth inside a minute is answered from cache rather than re-aggregated.
 */
const emailAnalyticsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:email:analytics",
  tag: EMAIL_WS_METHODS.analytics,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

const emailTriggerRulesQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:email:trigger-rules",
  tag: EMAIL_WS_METHODS.triggerRulesList,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

const emailTriggerFiringsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:email:trigger-firings",
  tag: EMAIL_WS_METHODS.triggerFiringsList,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

const EMPTY_EMAIL_MESSAGES: ReadonlyArray<CapturedEmailSummary> = Object.freeze([]);
const EMPTY_EMAIL_INBOXES: ReadonlyArray<EmailInboxSummary> = Object.freeze([]);

export interface EmailInboxView {
  readonly messages: ReadonlyArray<CapturedEmailSummary>;
  /** Every inbox the server knows about, not just the one in scope. */
  readonly inboxes: ReadonlyArray<EmailInboxSummary>;
  readonly status: EmailStoreStatus;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

/**
 * One scope's messages, kept current by the stream.
 *
 * The refetch is driven by an effect on `revision` rather than by keying the query on it: a new
 * atom key would start from an empty result and blank the list for the length of a round trip,
 * where a refresh keeps the rows up while the new ones land.
 */
export function useEmailInbox(scope: EmailInboxScope): EmailInboxView {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const streamView = useAtomValue(emailStreamViewAtom);
  // The scope is rebuilt from the URL on every render; the family keys on the JSON of its input
  // (`state/runtime.ts:425`), so an equal scope resolves to the same atom without a memo.
  const query = useEnvironmentQuery(
    environmentId === null ? null : emailListQuery({ environmentId, input: { scope } }),
  );

  const revision = streamView.state.revision;
  const refetch = useEffectEvent(() => query.refresh());
  useEffect(() => {
    if (revision === 0) return;
    refetch();
  }, [revision]);

  return {
    messages: query.data?.messages ?? EMPTY_EMAIL_MESSAGES,
    // The stream's copy is the later of the two whenever there is one, and it arrives without the
    // round trip the list read needs.
    inboxes: streamView.state.inboxes ?? query.data?.inboxes ?? EMPTY_EMAIL_INBOXES,
    status: query.error !== null ? "error" : streamView.status,
    isPending: query.isPending,
    error: query.error,
    refresh: query.refresh,
  };
}

/**
 * The inbox summaries alone, for the sidebar's badges.
 *
 * Reads the same query atom {@link useEmailInbox} does — the family keys on the JSON of its input,
 * so the two share one request — but installs no refetch of its own. The view owns that, and it is
 * always mounted whenever this sidebar is.
 */
export function useEmailInboxSummaries(scope: EmailInboxScope): ReadonlyArray<EmailInboxSummary> {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const streamView = useAtomValue(emailStreamViewAtom);
  const query = useEnvironmentQuery(
    environmentId === null ? null : emailListQuery({ environmentId, input: { scope } }),
  );
  return streamView.state.inboxes ?? query.data?.inboxes ?? EMPTY_EMAIL_INBOXES;
}

/**
 * Everything unread, wherever it was routed — the badge on the Email nav item.
 *
 * Shares the All-mail list atom with the Email view rather than adding a count-only read: it is the
 * same request the sidebar already makes, and after the first stream event the count comes off the
 * stream without any read at all.
 */
export function useEmailUnreadTotal(): number {
  return totalEmailUnreadCount(useEmailInboxSummaries(ALL_EMAIL_SCOPE));
}

export interface EmailAnalyticsView {
  /** Null until the first read lands, and held across a refetch so the charts never blank. */
  readonly analytics: EmailAnalyticsResult | null;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

/**
 * One scope's aggregates over one window.
 *
 * Refetched off the stream's `revision` for the same reason the message list is — a capture changes
 * the counts — and through `refresh()` rather than by re-keying, so a message landing mid-look
 * updates the columns in place instead of blanking the chart for a round trip.
 *
 * A null `input` (no environment, or the view not asking yet) reads as no request at all.
 */
export function useEmailAnalytics(input: EmailAnalyticsInput | null): EmailAnalyticsView {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const revision = useAtomValue(emailStreamViewAtom).state.revision;
  // The window is rebuilt from the range on every render; the family keys on the JSON of its input,
  // so an unchanged window resolves to the same atom without a memo.
  const query = useEnvironmentQuery(
    environmentId === null || input === null ? null : emailAnalyticsQuery({ environmentId, input }),
  );

  const refetch = useEffectEvent(() => query.refresh());
  useEffect(() => {
    if (revision === 0) return;
    refetch();
  }, [revision]);

  return {
    analytics: query.data ?? null,
    isPending: query.isPending,
    error: query.error,
    refresh: query.refresh,
  };
}

export interface EmailSettingsView {
  /** Null until the first read lands. */
  readonly settings: EmailCaptureSettings | null;
  readonly listenerStatus: EmailListenerStatus | null;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

/** Capture settings, preferring the stream's pushed snapshot over the read it started from. */
export function useEmailSettings(): EmailSettingsView {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const streamed = useAtomValue(emailStreamViewAtom).state.settings;
  const query = useEnvironmentQuery(
    environmentId === null ? null : emailSettingsQuery({ environmentId, input: {} }),
  );
  const snapshot = streamed ?? query.data ?? null;
  return {
    settings: snapshot?.settings ?? null,
    listenerStatus: snapshot?.listenerStatus ?? null,
    isPending: query.isPending,
    error: query.error,
    refresh: query.refresh,
  };
}

const EMPTY_EMAIL_TRIGGER_RULES: ReadonlyArray<EmailTriggerRule> = Object.freeze([]);
const EMPTY_EMAIL_TRIGGER_FIRINGS: ReadonlyArray<EmailTriggerFiring> = Object.freeze([]);

export interface EmailTriggerRulesView {
  readonly rules: ReadonlyArray<EmailTriggerRule>;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

/**
 * One project's trigger rules.
 *
 * Rules are refetched when loop detection auto-disables one, since that write happens on the server
 * with no client command to hang a refresh off.
 */
export function useEmailTriggerRules(projectId: ProjectId | null): EmailTriggerRulesView {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const autoDisabled = useAtomValue(emailStreamViewAtom).state.lastAutoDisabledTrigger;
  const query = useEnvironmentQuery(
    environmentId === null || projectId === null
      ? null
      : emailTriggerRulesQuery({ environmentId, input: { projectId } }),
  );

  const autoDisabledRuleId = autoDisabled?.rule.id ?? null;
  const refetch = useEffectEvent(() => query.refresh());
  useEffect(() => {
    if (autoDisabledRuleId === null) return;
    refetch();
  }, [autoDisabledRuleId]);

  return {
    rules: query.data?.rules ?? EMPTY_EMAIL_TRIGGER_RULES,
    isPending: query.isPending,
    error: query.error,
    refresh: query.refresh,
  };
}

export interface EmailTriggerFiringsView {
  readonly firings: ReadonlyArray<EmailTriggerFiring>;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

/** The firing log for a project: which message caused which run, and whether it launched. */
export function useEmailTriggerFirings(projectId: ProjectId | null): EmailTriggerFiringsView {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const revision = useAtomValue(emailStreamViewAtom).state.revision;
  const query = useEnvironmentQuery(
    environmentId === null || projectId === null
      ? null
      : emailTriggerFiringsQuery({ environmentId, input: { projectId } }),
  );

  // A firing is always caused by a capture, so the same signal that moves the message list is the
  // one that grows this log.
  const refetch = useEffectEvent(() => query.refresh());
  useEffect(() => {
    if (revision === 0) return;
    refetch();
  }, [revision]);

  return {
    firings: query.data?.firings ?? EMPTY_EMAIL_TRIGGER_FIRINGS,
    isPending: query.isPending,
    error: query.error,
    refresh: query.refresh,
  };
}

export interface EmailMessageView {
  /** Null until the first read lands. */
  readonly message: CapturedEmailMessage | null;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

/** The open message: bodies, attachments, and the SMTP transcript the list row does not carry. */
export function useEmailMessage(messageId: EmailMessageId | null): EmailMessageView {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const query = useEnvironmentQuery(
    environmentId === null || messageId === null
      ? null
      : emailMessageQuery({ environmentId, input: { messageId } }),
  );
  return {
    message: query.data?.message ?? null,
    isPending: query.isPending,
    error: query.error,
    refresh: query.refresh,
  };
}

// ── Mutations ──────────────────────────────────────────────────────────

export class EmailCaptureUnavailableError extends Data.TaggedError("EmailCaptureUnavailableError")<{
  readonly message: string;
}> {}

const emailCommandScheduler = createAtomCommandScheduler();

/**
 * Serial per environment. Read-state writes republish the whole inbox summary array, so two racing
 * writes would leave whichever returned first as the last word on every badge.
 */
const emailWriteOptions = {
  scheduler: emailCommandScheduler,
  concurrency: {
    mode: "serial",
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  },
} as const;

export const emailCommands = {
  markRead: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:email:mark-read",
    tag: EMAIL_WS_METHODS.markRead,
    ...emailWriteOptions,
  }),
  markUnread: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:email:mark-unread",
    tag: EMAIL_WS_METHODS.markUnread,
    ...emailWriteOptions,
  }),
  clearInbox: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:email:clear-inbox",
    tag: EMAIL_WS_METHODS.clearInbox,
    ...emailWriteOptions,
  }),
  // Settings are a single document: the listener card, the mute toggles, and the retention caps all
  // send the whole thing, so serialising them is what keeps two editors from clobbering each other.
  updateSettings: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:email:update-settings",
    tag: EMAIL_WS_METHODS.updateSettings,
    ...emailWriteOptions,
  }),
  upsertTriggerRule: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:email:trigger-rule-upsert",
    tag: EMAIL_WS_METHODS.triggerRulesUpsert,
    ...emailWriteOptions,
  }),
  deleteTriggerRule: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:email:trigger-rule-delete",
    tag: EMAIL_WS_METHODS.triggerRulesDelete,
    ...emailWriteOptions,
  }),
} as const;

type EmailCommandInput<C> =
  C extends AtomCommand<infer W, infer _A, infer _E>
    ? W extends { readonly input: infer I }
      ? I
      : never
    : never;
type EmailCommandSuccess<C> = C extends AtomCommand<infer _W, infer A, infer _E> ? A : never;
type EmailCommandFailure<C> = C extends AtomCommand<infer _W, infer _A, infer E> ? E : never;

/** Binds a write to the primary environment; captured mail exists nowhere else. */
function usePrimaryEmailCommand<
  C extends AtomCommand<
    { readonly environmentId: EnvironmentId; readonly input: never },
    unknown,
    unknown
  >,
>(
  command: C,
): (
  input: EmailCommandInput<C>,
) => Promise<
  AtomCommandResult<EmailCommandSuccess<C>, EmailCommandFailure<C> | EmailCaptureUnavailableError>
> {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const run = useAtomCommand(
    command as unknown as AtomCommand<
      { readonly environmentId: EnvironmentId; readonly input: EmailCommandInput<C> },
      EmailCommandSuccess<C>,
      EmailCommandFailure<C>
    >,
  );
  return useCallback(
    (input: EmailCommandInput<C>) =>
      environmentId === null
        ? Promise.resolve(
            AsyncResult.fail<EmailCaptureUnavailableError, EmailCommandSuccess<C>>(
              new EmailCaptureUnavailableError({
                message: "No environment is connected, so captured mail cannot be written to.",
              }),
            ),
          )
        : run({ environmentId, input }),
    [environmentId, run],
  );
}

export const useMarkEmailRead = () => usePrimaryEmailCommand(emailCommands.markRead);
export const useMarkEmailUnread = () => usePrimaryEmailCommand(emailCommands.markUnread);
export const useClearEmailInbox = () => usePrimaryEmailCommand(emailCommands.clearInbox);
export const useUpdateEmailSettings = () => usePrimaryEmailCommand(emailCommands.updateSettings);
export const useUpsertEmailTriggerRule = () =>
  usePrimaryEmailCommand(emailCommands.upsertTriggerRule);
export const useDeleteEmailTriggerRule = () =>
  usePrimaryEmailCommand(emailCommands.deleteTriggerRule);
