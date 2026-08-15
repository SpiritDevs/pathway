/**
 * Issue tracker client state — see `docs/internals/decisions/0006-issue-tracker.md`.
 *
 * The tracker is environment-scoped, and only the primary environment has one worth showing, so
 * every atom here is bound to `primaryEnvironmentIdAtom` rather than being a per-environment
 * family the way threads and pull requests are.
 *
 * Reads go through one subscription: `issues.stream` opens with the whole tracker replayed as
 * diffs and then carries only what changed, so there is no separate `issues.getSnapshot` call.
 * Writes are plain awaited RPCs — the store updates when the server echoes the change back on the
 * stream. There is no optimistic overlay: the socket is local, and the two mechanisms this
 * codebase has for optimism (a shadow atom merged at read time, `projectCommands.ts:47`) each
 * carry a reconciliation problem that a same-machine round trip does not pay for.
 *
 * @module state/issues
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
import { pinOrderKeyBetween } from "@spiritdevs/client-runtime/state/thread-sort";
import {
  ISSUES_WS_METHODS,
  issueCycleStatusOn,
  type EnvironmentId,
  type Issue,
  type IssueComment,
  type IssueCommentId,
  type IssueCycle,
  type IssueDate,
  type IssueDetail,
  type IssueEnrichmentRun,
  type IssueEnrichmentRunId,
  type IssueEvent,
  type IssueId,
  type IssueLabel,
  type IssueMilestone,
  type IssueMilestoneHistoryPoint,
  type IssueMilestoneId,
  type IssueRelationDirection,
  type IssueRelationEdge,
  type IssueRelationId,
  type IssueRelationKind,
  type IssueStatus,
  type IssueStatusCategory,
  type IssueThreadLink,
  type IssueTodo,
  type IssueTrackerConfig,
  type IssueView,
  type IssuesStreamEvent,
  type ProjectId,
  type SlackChannelId,
  type SlackChannelWatch,
  type SlackIntakeStatus,
  type ThreadId,
} from "@spiritdevs/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";
import { useCallback, useEffect, useEffectEvent, useMemo, useRef } from "react";

import { activeCompanyIdAtom } from "../cloud/activeCompany";
import { companyRegistryReplicasAtom } from "../cloud/companyRegistryReplica";
import { syncedIssueDomainAtom } from "../cloud/issueDomainReadModel";
import { connectionAtomRuntime } from "../connection/runtime";
import { issuesStoreFromReplica } from "./issuesFromReplica";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { useEnvironmentQuery } from "./query";
import { useAtomCommand } from "./use-atom-command";

// ── Store ──────────────────────────────────────────────────────────────

/** The tracker as the client holds it: issues keyed by id, everything else already ordered. */
export interface IssuesStore {
  readonly issuesById: ReadonlyMap<IssueId, Issue>;
  /** Ascending by position, `id` breaking ties so the order is total. */
  readonly statuses: ReadonlyArray<IssueStatus>;
  readonly labels: ReadonlyArray<IssueLabel>;
  /**
   * Every project's milestones in one array, grouped by project and ascending by position inside
   * it — the stream carries the whole set for the same reason it does for statuses, and a
   * per-project map would have to be rebuilt on every diff to answer "which projects have any".
   */
  readonly milestones: ReadonlyArray<IssueMilestone>;
  /** Ascending by start date, which is the order a cycle list reads in. */
  readonly cycles: ReadonlyArray<IssueCycle>;
  /** Saved views, ascending by position with `id` breaking ties — the order the sidebar pins. */
  readonly views: ReadonlyArray<IssueView>;
  /** Null until the stream's opening `ConfigChanged` lands. */
  readonly config: IssueTrackerConfig | null;
  /**
   * The watched Slack channels, ascending by channel name. Held in the list store rather than in
   * the settings page that edits them because a triage row needs the channel *name* and the
   * issue's `slackSource` only carries the id.
   */
  readonly slackWatches: ReadonlyArray<SlackChannelWatch>;
  /** Intake's health, as the server has known it since it woke up. */
  readonly slackStatus: SlackIntakeStatus;
}

const EMPTY_ISSUES: ReadonlyMap<IssueId, Issue> = new Map();
const EMPTY_STATUSES: ReadonlyArray<IssueStatus> = Object.freeze([]);
const EMPTY_LABELS: ReadonlyArray<IssueLabel> = Object.freeze([]);
const EMPTY_MILESTONES: ReadonlyArray<IssueMilestone> = Object.freeze([]);
const EMPTY_CYCLES: ReadonlyArray<IssueCycle> = Object.freeze([]);
const EMPTY_VIEWS: ReadonlyArray<IssueView> = Object.freeze([]);
const EMPTY_SLACK_WATCHES: ReadonlyArray<SlackChannelWatch> = Object.freeze([]);

/**
 * What intake looks like before the stream has said anything: not configured and never polled,
 * which is also the truth on a server with no token on disk.
 */
export const UNCONFIGURED_SLACK_INTAKE_STATUS: SlackIntakeStatus = Object.freeze({
  configured: false,
  lastPollAt: null,
  lastError: null,
  workspaceName: null,
});

export const EMPTY_ISSUES_STORE: IssuesStore = {
  issuesById: EMPTY_ISSUES,
  statuses: EMPTY_STATUSES,
  labels: EMPTY_LABELS,
  milestones: EMPTY_MILESTONES,
  cycles: EMPTY_CYCLES,
  views: EMPTY_VIEWS,
  config: null,
  slackWatches: EMPTY_SLACK_WATCHES,
  slackStatus: UNCONFIGURED_SLACK_INTAKE_STATUS,
};

function sortStatuses(statuses: ReadonlyArray<IssueStatus>): ReadonlyArray<IssueStatus> {
  return [...statuses].sort(
    (left, right) => left.position - right.position || left.id.localeCompare(right.id),
  );
}

function sortLabels(labels: ReadonlyArray<IssueLabel>): ReadonlyArray<IssueLabel> {
  return [...labels].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
}

function sortMilestones(milestones: ReadonlyArray<IssueMilestone>): ReadonlyArray<IssueMilestone> {
  return [...milestones].sort(
    (left, right) =>
      left.projectId.localeCompare(right.projectId) ||
      left.position - right.position ||
      left.id.localeCompare(right.id),
  );
}

/** `YYYY-MM-DD` sorts lexicographically, so a plain compare is the whole calculation. */
function sortCycles(cycles: ReadonlyArray<IssueCycle>): ReadonlyArray<IssueCycle> {
  return [...cycles].sort(
    (left, right) =>
      left.startDate.localeCompare(right.startDate) ||
      left.endDate.localeCompare(right.endDate) ||
      left.id.localeCompare(right.id),
  );
}

function sortViews(views: ReadonlyArray<IssueView>): ReadonlyArray<IssueView> {
  return [...views].sort(
    (left, right) => left.position - right.position || left.id.localeCompare(right.id),
  );
}

/**
 * By channel name, `id` breaking ties. The server answers in insertion order, which is the order
 * channels happened to be watched in — a settings table and a name lookup both want the alphabet.
 */
function sortSlackWatches(
  watches: ReadonlyArray<SlackChannelWatch>,
): ReadonlyArray<SlackChannelWatch> {
  return [...watches].sort(
    (left, right) =>
      left.channelName.localeCompare(right.channelName) || left.id.localeCompare(right.id),
  );
}

function sortTodos(todos: ReadonlyArray<IssueTodo>): ReadonlyArray<IssueTodo> {
  return [...todos].sort(
    (left, right) => left.position - right.position || left.id.localeCompare(right.id),
  );
}

function sortComments(comments: ReadonlyArray<IssueComment>): ReadonlyArray<IssueComment> {
  return [...comments].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
}

/**
 * Folds one diff into the store.
 *
 * A soft delete arrives as `IssueUpserted` carrying `deletedAt`, so the row stays: the depth cap
 * counts a soft-deleted row as an ancestor — it still holds its `parentId` — and a store that
 * dropped it would offer parents the server refuses. Every tab and rollup filters `deletedAt`
 * instead. `IssueDeleted` is the hard purge, and nothing publishes it yet.
 */
export function applyIssuesStreamEvent(
  current: IssuesStore,
  event: IssuesStreamEvent,
): IssuesStore {
  switch (event._tag) {
    case "IssueUpserted": {
      const issuesById = new Map(current.issuesById);
      issuesById.set(event.issue.id, event.issue);
      return { ...current, issuesById };
    }
    case "IssueDeleted": {
      if (!current.issuesById.has(event.issueId)) return current;
      const issuesById = new Map(current.issuesById);
      issuesById.delete(event.issueId);
      return { ...current, issuesById };
    }
    case "StatusesChanged":
      return { ...current, statuses: sortStatuses(event.statuses) };
    case "LabelsChanged":
      return { ...current, labels: sortLabels(event.labels) };
    case "MilestonesChanged":
      return { ...current, milestones: sortMilestones(event.milestones) };
    case "CyclesChanged":
      return { ...current, cycles: sortCycles(event.cycles) };
    case "ViewsChanged":
      return { ...current, views: sortViews(event.views) };
    case "ConfigChanged":
      return { ...current, config: event.config };
    // Intake is store state rather than settings-page state: the settings table is one reader, and
    // the triage row is the other — it resolves the channel *name* an issue's `slackSource` only
    // holds the id of.
    case "SlackWatchesChanged":
      return { ...current, slackWatches: sortSlackWatches(event.watches) };
    case "SlackStatusChanged":
      return { ...current, slackStatus: event.status };
    // The per-issue tails are not store state: they are read on demand and patched into whichever
    // detail is loaded, so the store must not re-render a list for a comment nobody is looking at.
    case "IssueTodosChanged":
    case "IssueRelationsChanged":
    case "IssueCommentUpserted":
    case "IssueCommentDeleted":
    // An agent's leavings are per-issue tails too: a run's transcript belongs to the panel
    // watching it, and a thread link to the sheet that is open.
    case "EnrichmentRunChanged":
    case "IssueThreadLinksChanged":
      return current;
  }
}

export function applyIssuesStreamEvents(
  current: IssuesStore,
  events: ReadonlyArray<IssuesStreamEvent>,
): IssuesStore {
  return events.reduce(applyIssuesStreamEvent, current);
}

// ── Detail overlay ─────────────────────────────────────────────────────

/**
 * What the stream has said about one issue's tail *since this connection opened*, laid over the
 * `issues.getDetail` read that the sheet made. The stream replays the tracker's configuration on
 * open but not the tails — those are per-issue reads — so an overlay is only ever a patch, never a
 * source of truth on its own.
 *
 * Todos and relations arrive as whole lists, so a patch replaces them outright. Comments arrive one
 * at a time, so they are held as a per-id patch map in which a `null` is a tombstone: the read that
 * the sheet is holding still carries a comment the server has since deleted.
 */
export interface IssueDetailOverlay {
  readonly todos: ReadonlyArray<IssueTodo> | null;
  readonly relations: ReadonlyArray<IssueRelationEdge> | null;
  readonly comments: ReadonlyMap<IssueCommentId, IssueComment | null>;
}

export type IssueDetailOverlays = ReadonlyMap<IssueId, IssueDetailOverlay>;

const EMPTY_COMMENT_PATCHES: ReadonlyMap<IssueCommentId, IssueComment | null> = new Map();

const EMPTY_ISSUE_DETAIL_OVERLAY: IssueDetailOverlay = {
  todos: null,
  relations: null,
  comments: EMPTY_COMMENT_PATCHES,
};

export const EMPTY_ISSUE_DETAIL_OVERLAYS: IssueDetailOverlays = new Map();

function patchOverlay(
  current: IssueDetailOverlays,
  issueId: IssueId,
  patch: (overlay: IssueDetailOverlay) => IssueDetailOverlay,
): IssueDetailOverlays {
  const next = new Map(current);
  next.set(issueId, patch(current.get(issueId) ?? EMPTY_ISSUE_DETAIL_OVERLAY));
  return next;
}

/**
 * Folds one diff into the per-issue overlays. Deliberately kept out of {@link IssuesStore}: these
 * events fire while a sheet is open and editing a checklist should not invalidate the list view.
 *
 * Overlays are only dropped when their issue is, and are rebuilt from nothing on every reconnect
 * along with the rest of the fold, so the map is bounded by the issues edited in one session.
 */
export function applyIssueDetailStreamEvent(
  current: IssueDetailOverlays,
  event: IssuesStreamEvent,
): IssueDetailOverlays {
  switch (event._tag) {
    case "IssueTodosChanged":
      return patchOverlay(current, event.issueId, (overlay) => ({
        ...overlay,
        todos: sortTodos(event.todos),
      }));
    case "IssueRelationsChanged":
      return patchOverlay(current, event.issueId, (overlay) => ({
        ...overlay,
        relations: event.relations,
      }));
    case "IssueCommentUpserted":
      return patchOverlay(current, event.comment.issueId, (overlay) => ({
        ...overlay,
        comments: new Map(overlay.comments).set(event.comment.id, event.comment),
      }));
    case "IssueCommentDeleted":
      return patchOverlay(current, event.issueId, (overlay) => ({
        ...overlay,
        comments: new Map(overlay.comments).set(event.commentId, null),
      }));
    case "IssueDeleted": {
      if (!current.has(event.issueId)) return current;
      const next = new Map(current);
      next.delete(event.issueId);
      return next;
    }
    case "IssueUpserted":
    case "StatusesChanged":
    case "LabelsChanged":
    case "MilestonesChanged":
    case "CyclesChanged":
    case "ViewsChanged":
    case "ConfigChanged":
    // Enrichment runs and thread links are read on demand like the tails above, but they are not
    // part of this overlay: the run panel and the thread list hold their own.
    case "EnrichmentRunChanged":
    case "IssueThreadLinksChanged":
    case "SlackWatchesChanged":
    case "SlackStatusChanged":
      return current;
  }
}

// ── Agent overlay ──────────────────────────────────────────────────────

/**
 * What agents have left on the tracker *since this connection opened*: enrichment runs and
 * thread links. Both are per-issue tails read on demand, like todos and comments, but they are
 * held apart from {@link IssueDetailOverlay} because one of them is not a sheet concern at all —
 * the list draws a marker on any issue with an investigation in flight, and that has to be true
 * for issues whose sheet has never been opened.
 *
 * The id sets are membership-stable on purpose: a running run republishes its whole row every
 * 250ms, and fresh `Set`s on each of those would re-render subscribers four times a second to say
 * nothing new.
 */
export interface IssueAgentState {
  /** Keyed by run id rather than held as a list: the stream carries one run at a time. */
  readonly runsByIssue: ReadonlyMap<IssueId, ReadonlyMap<IssueEnrichmentRunId, IssueEnrichmentRun>>;
  /** The whole list per issue, which is what the stream event carries. */
  readonly linksByIssue: ReadonlyMap<IssueId, ReadonlyArray<IssueThreadLink>>;
  /** Every issue with a `queued` or `running` run, as far as this connection has been told. */
  readonly investigatingIssueIds: ReadonlySet<IssueId>;
  /** Every issue with a queued, running, or completed run observed on this connection. */
  readonly investigatedIssueIds: ReadonlySet<IssueId>;
}

const EMPTY_ENRICHMENT_RUNS: ReadonlyMap<
  IssueId,
  ReadonlyMap<IssueEnrichmentRunId, IssueEnrichmentRun>
> = new Map();
const EMPTY_THREAD_LINKS_BY_ISSUE: ReadonlyMap<IssueId, ReadonlyArray<IssueThreadLink>> = new Map();
const EMPTY_INVESTIGATING_IDS: ReadonlySet<IssueId> = new Set();
const EMPTY_INVESTIGATED_IDS: ReadonlySet<IssueId> = new Set();

export const EMPTY_ISSUE_AGENT_STATE: IssueAgentState = {
  runsByIssue: EMPTY_ENRICHMENT_RUNS,
  linksByIssue: EMPTY_THREAD_LINKS_BY_ISSUE,
  investigatingIssueIds: EMPTY_INVESTIGATING_IDS,
  investigatedIssueIds: EMPTY_INVESTIGATED_IDS,
};

/** Queued and running are the two states a cancel button and a marker chip both apply to. */
export function isIssueEnrichmentRunActive(run: IssueEnrichmentRun): boolean {
  return run.state === "queued" || run.state === "running";
}

function withInvestigatingIssue(
  current: ReadonlySet<IssueId>,
  issueId: IssueId,
  active: boolean,
): ReadonlySet<IssueId> {
  if (current.has(issueId) === active) return current;
  const next = new Set(current);
  if (active) next.add(issueId);
  else next.delete(issueId);
  return next;
}

/**
 * Folds one diff into the agent overlay. Returns `current` for every tag it does not own, which
 * is most of them — the tracker's own diffs must not invalidate a transcript that is streaming.
 */
export function applyIssueAgentStreamEvent(
  current: IssueAgentState,
  event: IssuesStreamEvent,
): IssueAgentState {
  switch (event._tag) {
    case "EnrichmentRunChanged": {
      const { run } = event;
      const runs = new Map(current.runsByIssue.get(run.issueId) ?? []);
      runs.set(run.id, run);
      const runsByIssue = new Map(current.runsByIssue);
      runsByIssue.set(run.issueId, runs);
      // Recomputed across the issue's whole known set rather than read off this one run: a second
      // run can be queued behind the one that just finished.
      const active = [...runs.values()].some(isIssueEnrichmentRunActive);
      // A failed attempt may be retried on acceptance; an active or completed run should not be
      // offered again by default. The user can still opt into another run explicitly.
      const investigated = [...runs.values()].some((candidate) => candidate.state !== "failed");
      return {
        ...current,
        runsByIssue,
        investigatingIssueIds: withInvestigatingIssue(
          current.investigatingIssueIds,
          run.issueId,
          active,
        ),
        investigatedIssueIds: withInvestigatingIssue(
          current.investigatedIssueIds,
          run.issueId,
          investigated,
        ),
      };
    }
    case "IssueThreadLinksChanged": {
      const linksByIssue = new Map(current.linksByIssue);
      linksByIssue.set(event.issueId, event.links);
      return { ...current, linksByIssue };
    }
    case "IssueDeleted": {
      if (
        !current.runsByIssue.has(event.issueId) &&
        !current.linksByIssue.has(event.issueId) &&
        !current.investigatingIssueIds.has(event.issueId) &&
        !current.investigatedIssueIds.has(event.issueId)
      ) {
        return current;
      }
      const runsByIssue = new Map(current.runsByIssue);
      runsByIssue.delete(event.issueId);
      const linksByIssue = new Map(current.linksByIssue);
      linksByIssue.delete(event.issueId);
      return {
        runsByIssue,
        linksByIssue,
        investigatingIssueIds: withInvestigatingIssue(
          current.investigatingIssueIds,
          event.issueId,
          false,
        ),
        investigatedIssueIds: withInvestigatingIssue(
          current.investigatedIssueIds,
          event.issueId,
          false,
        ),
      };
    }
    case "IssueUpserted":
    case "StatusesChanged":
    case "LabelsChanged":
    case "MilestonesChanged":
    case "CyclesChanged":
    case "ViewsChanged":
    case "ConfigChanged":
    case "IssueTodosChanged":
    case "IssueRelationsChanged":
    case "IssueCommentUpserted":
    case "IssueCommentDeleted":
    case "SlackWatchesChanged":
    case "SlackStatusChanged":
      return current;
  }
}

/**
 * Newest first, matching what `issues.getEnrichmentRuns` answers with. The server breaks a
 * same-millisecond tie on `rowid`, which no client can see; the id is the deterministic stand-in,
 * and two runs a millisecond apart on one issue is already a case that cannot happen — the server
 * refuses a second run while one is in flight.
 */
export function compareIssueEnrichmentRuns(
  left: IssueEnrichmentRun,
  right: IssueEnrichmentRun,
): number {
  return right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id);
}

/**
 * Lays the live patches over the `issues.getEnrichmentRuns` read the panel made. The patch always
 * wins: it is the later of the two, since a read is answered from the state the diffs publish from.
 */
export function mergeIssueEnrichmentRuns(
  seed: ReadonlyArray<IssueEnrichmentRun>,
  patches: ReadonlyMap<IssueEnrichmentRunId, IssueEnrichmentRun> | undefined,
): ReadonlyArray<IssueEnrichmentRun> {
  if (patches === undefined || patches.size === 0)
    return [...seed].sort(compareIssueEnrichmentRuns);
  const byId = new Map(seed.map((run) => [run.id, run]));
  for (const [runId, run] of patches) byId.set(runId, run);
  return [...byId.values()].sort(compareIssueEnrichmentRuns);
}

/** The whole accumulator the subscription carries: the tracker, plus whatever tails changed. */
export interface IssuesStreamState {
  readonly store: IssuesStore;
  readonly details: IssueDetailOverlays;
  readonly agents: IssueAgentState;
}

export const EMPTY_ISSUES_STREAM_STATE: IssuesStreamState = {
  store: EMPTY_ISSUES_STORE,
  details: EMPTY_ISSUE_DETAIL_OVERLAYS,
  agents: EMPTY_ISSUE_AGENT_STATE,
};

/** Returns `current` untouched when no part moved, so an unrelated diff notifies nobody. */
export function applyIssuesStreamStateEvents(
  current: IssuesStreamState,
  events: ReadonlyArray<IssuesStreamEvent>,
): IssuesStreamState {
  return events.reduce((state, event): IssuesStreamState => {
    const store = applyIssuesStreamEvent(state.store, event);
    const details = applyIssueDetailStreamEvent(state.details, event);
    const agents = applyIssueAgentStreamEvent(state.agents, event);
    return store === state.store && details === state.details && agents === state.agents
      ? state
      : { store, details, agents };
  }, current);
}

/**
 * Lays the live overlay over a loaded detail. The overlay always wins: it is the later of the two
 * by construction, since a read is answered from the same state the diffs are published from.
 */
export function mergeIssueDetail(
  detail: IssueDetail,
  overlay: IssueDetailOverlay | undefined,
): IssueDetail {
  const patches = overlay?.comments ?? EMPTY_COMMENT_PATCHES;
  let comments = detail.comments;
  if (patches.size > 0) {
    const byId = new Map(comments.map((comment) => [comment.id, comment]));
    for (const [commentId, comment] of patches) {
      if (comment === null) byId.delete(commentId);
      else byId.set(commentId, comment);
    }
    comments = [...byId.values()];
  }
  return {
    todos: overlay?.todos ?? sortTodos(detail.todos),
    relations: overlay?.relations ?? detail.relations,
    comments: sortComments(comments),
  };
}

// ── Subscription ───────────────────────────────────────────────────────

/**
 * The connection generation, mirroring what `createEnvironmentQueryAtomFamily` uses to re-run a
 * read after a reconnect. The issues stream carries diffs and has no snapshot variant, so a fold
 * that survived a disconnect would keep rows the server deleted while this client was away.
 * Keying the subscription on the generation gives each connection a fresh, empty accumulator that
 * the reconnect's replay rebuilds.
 */
const issuesConnectionGenerationAtom = Atom.family((environmentId: EnvironmentId) =>
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
    .pipe(Atom.withLabel(`web-issues:connection-generation:${environmentId}`)),
);

/**
 * Folded a chunk at a time rather than an event at a time: the stream opens by replaying every
 * issue as its own `IssueUpserted`, and a tracker of a few hundred rows should not re-render the
 * list a few hundred times to arrive at its first paint.
 */
const issuesChanges = createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
  label: "environment-data:issues:changes",
  subscribe: (_generation: number) =>
    subscribe(ISSUES_WS_METHODS.stream, {}).pipe(
      Stream.chunks,
      Stream.mapAccum(
        () => EMPTY_ISSUES_STREAM_STATE,
        (state: IssuesStreamState, events: ReadonlyArray<IssuesStreamEvent>) => {
          const next = applyIssuesStreamStateEvents(state, events);
          return [next, [next]] as const;
        },
      ),
    ),
});

export type IssuesStoreStatus = "disconnected" | "loading" | "ready" | "error";

export interface IssuesStoreState {
  readonly store: IssuesStore;
  readonly status: IssuesStoreStatus;
}

interface IssuesStreamView {
  readonly state: IssuesStreamState;
  readonly status: IssuesStoreStatus;
}

const DISCONNECTED_ISSUES_STREAM_VIEW: IssuesStreamView = {
  state: EMPTY_ISSUES_STREAM_STATE,
  status: "disconnected",
};

const issuesStreamViewAtom = Atom.make((get): IssuesStreamView => {
  const environmentId = get(primaryEnvironmentIdAtom);
  if (environmentId === null) return DISCONNECTED_ISSUES_STREAM_VIEW;
  const generation = Option.getOrNull(
    AsyncResult.value(get(issuesConnectionGenerationAtom(environmentId))),
  );
  if (generation === null) return DISCONNECTED_ISSUES_STREAM_VIEW;

  const changes = get(issuesChanges({ environmentId, input: generation }));
  const state = Option.getOrElse(AsyncResult.value(changes), () => EMPTY_ISSUES_STREAM_STATE);
  if (AsyncResult.isFailure(changes)) return { state, status: "error" };
  return { state, status: AsyncResult.isSuccess(changes) ? "ready" : "loading" };
}).pipe(Atom.withLabel("web-issues-stream-view"));

/** Replica presence is the sync engine's usable-data signal; freshness is owned by the engine. */
export function selectIssuesStoreState(
  legacyState: IssuesStoreState,
  replicaStore: IssuesStore | null,
): IssuesStoreState {
  return replicaStore === null ? legacyState : { store: replicaStore, status: "ready" };
}

export const issuesStoreStateAtom = Atom.make((get): IssuesStoreState => {
  const view = get(issuesStreamViewAtom);
  const legacyState: IssuesStoreState = { store: view.state.store, status: view.status };
  const activeCompanyId = get(activeCompanyIdAtom);
  if (activeCompanyId === null || !get(companyRegistryReplicasAtom).has(activeCompanyId)) {
    return selectIssuesStoreState(legacyState, null);
  }
  return selectIssuesStoreState(
    legacyState,
    issuesStoreFromReplica(get(syncedIssueDomainAtom), legacyState.store),
  );
}).pipe(Atom.withLabel("web-issues-store-state"));

export const issuesStoreAtom = Atom.make(
  (get): IssuesStore => get(issuesStoreStateAtom).store,
).pipe(Atom.withLabel("web-issues-store"));

export const issueStatusesAtom = Atom.make(
  (get): ReadonlyArray<IssueStatus> => get(issuesStoreAtom).statuses,
).pipe(Atom.withLabel("web-issue-statuses"));

export const issueLabelsAtom = Atom.make(
  (get): ReadonlyArray<IssueLabel> => get(issuesStoreAtom).labels,
).pipe(Atom.withLabel("web-issue-labels"));

export const issueMilestonesAtom = Atom.make(
  (get): ReadonlyArray<IssueMilestone> => get(issuesStoreAtom).milestones,
).pipe(Atom.withLabel("web-issue-milestones"));

export const issueCyclesAtom = Atom.make(
  (get): ReadonlyArray<IssueCycle> => get(issuesStoreAtom).cycles,
).pipe(Atom.withLabel("web-issue-cycles"));

export const issueViewsAtom = Atom.make(
  (get): ReadonlyArray<IssueView> => get(issuesStoreAtom).views,
).pipe(Atom.withLabel("web-issue-views"));

export const issueTrackerConfigAtom = Atom.make(
  (get): IssueTrackerConfig | null => get(issuesStoreAtom).config,
).pipe(Atom.withLabel("web-issue-tracker-config"));

export const slackWatchesAtom = Atom.make(
  (get): ReadonlyArray<SlackChannelWatch> => get(issuesStoreAtom).slackWatches,
).pipe(Atom.withLabel("web-issue-slack-watches"));

export const slackIntakeStatusAtom = Atom.make(
  (get): SlackIntakeStatus => get(issuesStoreAtom).slackStatus,
).pipe(Atom.withLabel("web-issue-slack-status"));

const issueDetailOverlaysAtom = Atom.make(
  (get): IssueDetailOverlays => get(issuesStreamViewAtom).state.details,
).pipe(Atom.withLabel("web-issue-detail-overlays"));

const issueDetailOverlayAtomFamily = Atom.family((issueId: IssueId) =>
  Atom.make((get): IssueDetailOverlay | undefined =>
    get(issueDetailOverlaysAtom).get(issueId),
  ).pipe(Atom.withLabel(`web-issue-detail-overlay:${issueId}`)),
);

const EMPTY_ISSUE_DETAIL_OVERLAY_ATOM = Atom.make<IssueDetailOverlay | undefined>(undefined).pipe(
  Atom.withLabel("web-issue-detail-overlay:empty"),
);

const issueAgentStateAtom = Atom.make(
  (get): IssueAgentState => get(issuesStreamViewAtom).state.agents,
).pipe(Atom.withLabel("web-issue-agent-state"));

/**
 * The issue that created each work thread. Manual links remain a detail-sheet concern: the
 * sidebar code is provenance, matching the thread-details issue panel.
 */
export function startWorkIssuesByThread(
  issuesById: ReadonlyMap<IssueId, Issue>,
  linksByIssue: ReadonlyMap<IssueId, ReadonlyArray<IssueThreadLink>>,
): ReadonlyMap<ThreadId, Issue> {
  const candidates = new Map<ThreadId, { readonly issue: Issue; readonly createdAt: string }>();
  for (const [issueId, links] of linksByIssue) {
    const issue = issuesById.get(issueId);
    if (issue === undefined) continue;
    for (const link of links) {
      if (link.origin !== "start-work") continue;
      const current = candidates.get(link.threadId);
      if (
        current === undefined ||
        link.createdAt < current.createdAt ||
        (link.createdAt === current.createdAt && issue.key < current.issue.key)
      ) {
        candidates.set(link.threadId, { issue, createdAt: link.createdAt });
      }
    }
  }
  return new Map([...candidates].map(([threadId, candidate]) => [threadId, candidate.issue]));
}

const startWorkIssuesByThreadAtom = Atom.make(
  (get): ReadonlyMap<ThreadId, Issue> =>
    startWorkIssuesByThread(get(issuesStoreAtom).issuesById, get(issueAgentStateAtom).linksByIssue),
).pipe(Atom.withLabel("web-start-work-issues-by-thread"));

/**
 * The issues with an investigation in flight, for the marker on a list row or a board card. One
 * subscription for the whole list rather than one per row, and the set only changes identity when
 * its membership does.
 *
 * A reconnect starts the fold empty, so a run that is *queued* behind another and publishes
 * nothing in the meantime stays unmarked until it starts. A `running` run marks itself within one
 * transcript window.
 */
export const investigatingIssueIdsAtom = Atom.make(
  (get): ReadonlySet<IssueId> => get(issueAgentStateAtom).investigatingIssueIds,
).pipe(Atom.withLabel("web-issues-investigating"));

const investigatedIssueIdsAtom = Atom.make(
  (get): ReadonlySet<IssueId> => get(issueAgentStateAtom).investigatedIssueIds,
).pipe(Atom.withLabel("web-issues-investigated"));

const issueEnrichmentRunPatchesAtomFamily = Atom.family((issueId: IssueId) =>
  Atom.make((get): ReadonlyMap<IssueEnrichmentRunId, IssueEnrichmentRun> | undefined =>
    get(issueAgentStateAtom).runsByIssue.get(issueId),
  ).pipe(Atom.withLabel(`web-issue-enrichment-runs:${issueId}`)),
);

const EMPTY_ENRICHMENT_RUN_PATCHES_ATOM = Atom.make<
  ReadonlyMap<IssueEnrichmentRunId, IssueEnrichmentRun> | undefined
>(undefined).pipe(Atom.withLabel("web-issue-enrichment-runs:empty"));

const issueThreadLinkPatchAtomFamily = Atom.family((issueId: IssueId) =>
  Atom.make((get): ReadonlyArray<IssueThreadLink> | undefined =>
    get(issueAgentStateAtom).linksByIssue.get(issueId),
  ).pipe(Atom.withLabel(`web-issue-thread-links:${issueId}`)),
);

const EMPTY_THREAD_LINK_PATCH_ATOM = Atom.make<ReadonlyArray<IssueThreadLink> | undefined>(
  undefined,
).pipe(Atom.withLabel("web-issue-thread-links:empty"));

// ── Tabs and grouping ──────────────────────────────────────────────────

/**
 * Driven by status *category*, not by a hand-maintained list of status names — the decision
 * record's reason for putting a category on a status at all.
 */
export type IssuesTab = "active" | "backlog" | "all";

const ACTIVE_CATEGORIES: ReadonlyArray<IssueStatusCategory> = ["unstarted", "started", "review"];
const BACKLOG_CATEGORIES: ReadonlyArray<IssueStatusCategory> = ["backlog"];

export function issuesTabCategories(tab: IssuesTab): ReadonlyArray<IssueStatusCategory> | null {
  if (tab === "active") return ACTIVE_CATEGORIES;
  if (tab === "backlog") return BACKLOG_CATEGORIES;
  return null;
}

export interface IssueGroup {
  readonly status: IssueStatus;
  /** Ascending by `sortOrder`, `id` breaking ties. */
  readonly issues: ReadonlyArray<Issue>;
}

/** Groups are emitted for every status in the tab, empty ones included, so a list can render an
    empty column header rather than having the column disappear when its last issue moves. */
export interface IssuesGrouping {
  readonly groups: ReadonlyArray<IssueGroup>;
  readonly total: number;
}

const EMPTY_ISSUES_GROUPING: IssuesGrouping = { groups: Object.freeze([]), total: 0 };

/** Display order anywhere a set of issues is listed: the fractional key, `id` breaking ties. */
function compareIssueOrder(left: Issue, right: Issue): number {
  return (
    (left.sortOrder < right.sortOrder ? -1 : left.sortOrder > right.sortOrder ? 1 : 0) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Triage items are excluded from every tab. Triage is deliberately not a status or a sixth
 * category: it is state outside the workflow, and an item sitting in it appears in no board and
 * no count until somebody accepts it. Soft-deleted rows are excluded too — the store keeps them
 * so a restore needs no second read, not so they can be listed.
 */
export function groupIssuesForTab(store: IssuesStore, tab: IssuesTab): IssuesGrouping {
  const categories = issuesTabCategories(tab);
  const statuses =
    categories === null
      ? store.statuses
      : store.statuses.filter((status) => categories.includes(status.category));
  if (statuses.length === 0) return EMPTY_ISSUES_GROUPING;

  const byStatus = new Map<string, Array<Issue>>(statuses.map((status) => [status.id, []]));
  let total = 0;
  for (const issue of store.issuesById.values()) {
    if (issue.deletedAt !== null || issue.triage) continue;
    const bucket = byStatus.get(issue.statusId);
    if (bucket === undefined) continue;
    bucket.push(issue);
    total += 1;
  }

  return {
    groups: statuses.map((status) => ({
      status,
      issues: (byStatus.get(status.id) ?? []).sort(compareIssueOrder),
    })),
    total,
  };
}

/** The sidebar's pending count. Deleted triage items do not pend. */
export function countTriageIssues(store: IssuesStore): number {
  let count = 0;
  for (const issue of store.issuesById.values()) {
    if (issue.triage && issue.deletedAt === null) count += 1;
  }
  return count;
}

/**
 * The triage queue, newest first.
 *
 * Not `sortOrder`: nothing drags a triage item, and intake appends, so the fractional key is the
 * arrival order read backwards. What a queue wants is the newest message at the top, and
 * `createdAt` says that without depending on a key nobody wrote by hand.
 */
export function listTriageIssues(store: IssuesStore): ReadonlyArray<Issue> {
  const triage: Array<Issue> = [];
  for (const issue of store.issuesById.values()) {
    if (issue.triage && issue.deletedAt === null) triage.push(issue);
  }
  return triage.sort(
    (left, right) =>
      right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id),
  );
}

/** Channel id → the name it was watched under, for a triage row's source chip. */
export function slackChannelNames(store: IssuesStore): ReadonlyMap<SlackChannelId, string> {
  return new Map(store.slackWatches.map((watch) => [watch.channelId, watch.channelName]));
}

/** Accepts either the human key (`PAT-221`, what the URL carries) or the row id. */
export function findIssue(store: IssuesStore, issueKeyOrId: string): Issue | null {
  const byId = store.issuesById.get(issueKeyOrId as IssueId);
  if (byId !== undefined) return byId;
  for (const issue of store.issuesById.values()) {
    if (issue.key === issueKeyOrId) return issue;
  }
  return null;
}

/**
 * Every issue indexed by its human key, for surfaces that resolve a set of keys at once — chat
 * mentions, the thread issue panel — where a per-key read would mean an unbounded atom cache or a
 * hook count that changes with the text. Soft-deleted issues stay in the map: a mention of one is
 * still a real reference, and the UI says so with a Deleted chip.
 */
export function issuesByKey(store: IssuesStore): ReadonlyMap<string, Issue> {
  const byKey = new Map<string, Issue>();
  for (const issue of store.issuesById.values()) byKey.set(issue.key, issue);
  return byKey;
}

const issuesGroupedAtomFamily = Atom.family((tab: IssuesTab) =>
  Atom.make((get): IssuesGrouping => groupIssuesForTab(get(issuesStoreAtom), tab)).pipe(
    Atom.withLabel(`web-issues-grouped:${tab}`),
  ),
);

export const triageCountAtom = Atom.make((get): number =>
  countTriageIssues(get(issuesStoreAtom)),
).pipe(Atom.withLabel("web-issues-triage-count"));

export const triageIssuesAtom = Atom.make(
  (get): ReadonlyArray<Issue> => listTriageIssues(get(issuesStoreAtom)),
).pipe(Atom.withLabel("web-issues-triage"));

export const slackChannelNamesAtom = Atom.make(
  (get): ReadonlyMap<SlackChannelId, string> => slackChannelNames(get(issuesStoreAtom)),
).pipe(Atom.withLabel("web-issues-slack-channel-names"));

export const issuesByKeyAtom = Atom.make(
  (get): ReadonlyMap<string, Issue> => issuesByKey(get(issuesStoreAtom)),
).pipe(Atom.withLabel("web-issues-by-key"));

const EMPTY_ISSUES_BY_KEY: ReadonlyMap<string, Issue> = new Map();

/** A constant stands in for the index so a caller with no keys never subscribes to the tracker. */
const EMPTY_ISSUES_BY_KEY_ATOM = Atom.make(EMPTY_ISSUES_BY_KEY).pipe(
  Atom.withLabel("web-issues-by-key:empty"),
);

const issueAtomFamily = Atom.family((issueKeyOrId: string) =>
  Atom.make((get): Issue | null => findIssue(get(issuesStoreAtom), issueKeyOrId)).pipe(
    Atom.withLabel(`web-issue:${issueKeyOrId}`),
  ),
);

const EMPTY_ISSUE_ATOM = Atom.make<Issue | null>(null).pipe(Atom.withLabel("web-issue:empty"));

// ── Milestones and cycles ──────────────────────────────────────────────

/** The one project's checkpoints, in the order the sidebar expands them into. */
export function issueMilestonesForProject(
  store: IssuesStore,
  projectId: ProjectId,
): ReadonlyArray<IssueMilestone> {
  return store.milestones.filter((milestone) => milestone.projectId === projectId);
}

/**
 * Today as the tracker counts it: the *local* calendar day, matching what the server's cycle
 * finalisation uses. A due date and a cycle boundary mean the same day everywhere, so neither is
 * read out of a timestamp.
 */
export function todayIssueDate(now: Date = new Date()): IssueDate {
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  const day = `${now.getDate()}`.padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

/**
 * The three buckets a cycle list renders. `active` is an array because nothing stops two cycles
 * from overlapping — they are hand-created date ranges — and picking one silently would hide the
 * mistake rather than show it.
 */
export interface IssueCyclesByStatus {
  readonly active: ReadonlyArray<IssueCycle>;
  readonly upcoming: ReadonlyArray<IssueCycle>;
  readonly ended: ReadonlyArray<IssueCycle>;
}

export function issueCyclesByStatus(
  cycles: ReadonlyArray<IssueCycle>,
  today: IssueDate,
): IssueCyclesByStatus {
  const active: Array<IssueCycle> = [];
  const upcoming: Array<IssueCycle> = [];
  const ended: Array<IssueCycle> = [];
  for (const cycle of cycles) {
    const status = issueCycleStatusOn(cycle, today);
    if (status === "active") active.push(cycle);
    else if (status === "upcoming") upcoming.push(cycle);
    else ended.push(cycle);
  }
  return { active, upcoming, ended };
}

/** The earliest-starting cycle covering today, which is the one the sidebar heads its list with. */
export function activeIssueCycle(
  cycles: ReadonlyArray<IssueCycle>,
  today: IssueDate,
): IssueCycle | null {
  return issueCyclesByStatus(cycles, today).active[0] ?? null;
}

export function upcomingIssueCycles(
  cycles: ReadonlyArray<IssueCycle>,
  today: IssueDate,
): ReadonlyArray<IssueCycle> {
  return issueCyclesByStatus(cycles, today).upcoming;
}

// ── Rollups ────────────────────────────────────────────────────────────

/**
 * The `3/9` a sub-issue or milestone row shows. `done` counts the `completed` category; a canceled
 * issue leaves the denominator entirely, because it is no longer work the parent is waiting on.
 * Triage items and soft-deleted rows are excluded for the same reason they are excluded from a tab.
 */
export interface IssueProgress {
  readonly done: number;
  readonly total: number;
}

export interface IssueChildRollup extends IssueProgress {
  /** Ascending by `sortOrder`, `id` breaking ties — the order the sub-issue list renders in. */
  readonly childIds: ReadonlyArray<IssueId>;
}

export const EMPTY_ISSUE_CHILD_ROLLUP: IssueChildRollup = {
  childIds: Object.freeze([]),
  done: 0,
  total: 0,
};

const EMPTY_ISSUE_PROGRESS: IssueProgress = { done: 0, total: 0 };

function issueStatusCategories(
  store: IssuesStore,
): ReadonlyMap<IssueStatus["id"], IssueStatusCategory> {
  return new Map(store.statuses.map((status) => [status.id, status.category]));
}

/** Whether an issue is one a rollup counts at all. */
function isRollupIssue(issue: Issue): boolean {
  return issue.deletedAt === null && !issue.triage;
}

function tallyProgress(
  issues: ReadonlyArray<Issue>,
  categories: ReadonlyMap<IssueStatus["id"], IssueStatusCategory>,
): IssueProgress {
  let done = 0;
  let total = 0;
  for (const issue of issues) {
    const category = categories.get(issue.statusId);
    if (category === "canceled") continue;
    total += 1;
    if (category === "completed") done += 1;
  }
  return { done, total };
}

/** Every parent's children in one pass, so a list of a hundred rows does not scan the tracker once per row. */
export function issueChildRollups(store: IssuesStore): ReadonlyMap<IssueId, IssueChildRollup> {
  const categories = issueStatusCategories(store);
  const byParent = new Map<IssueId, Array<Issue>>();
  for (const issue of store.issuesById.values()) {
    if (issue.parentId === null || !isRollupIssue(issue)) continue;
    const bucket = byParent.get(issue.parentId);
    if (bucket === undefined) byParent.set(issue.parentId, [issue]);
    else bucket.push(issue);
  }

  const rollups = new Map<IssueId, IssueChildRollup>();
  for (const [parentId, children] of byParent) {
    const ordered = [...children].sort(compareIssueOrder);
    rollups.set(parentId, {
      childIds: ordered.map((child) => child.id),
      ...tallyProgress(ordered, categories),
    });
  }
  return rollups;
}

export function issueChildRollup(store: IssuesStore, issueId: IssueId): IssueChildRollup {
  return issueChildRollups(store).get(issueId) ?? EMPTY_ISSUE_CHILD_ROLLUP;
}

export function issueMilestoneProgressByMilestone(
  store: IssuesStore,
): ReadonlyMap<IssueMilestoneId, IssueProgress> {
  const categories = issueStatusCategories(store);
  const byMilestone = new Map<IssueMilestoneId, Array<Issue>>();
  for (const issue of store.issuesById.values()) {
    if (issue.milestoneId === null || !isRollupIssue(issue)) continue;
    const bucket = byMilestone.get(issue.milestoneId);
    if (bucket === undefined) byMilestone.set(issue.milestoneId, [issue]);
    else bucket.push(issue);
  }

  const progress = new Map<IssueMilestoneId, IssueProgress>();
  for (const milestone of store.milestones) {
    progress.set(milestone.id, tallyProgress(byMilestone.get(milestone.id) ?? [], categories));
  }
  return progress;
}

export function issueMilestoneProgress(
  store: IssuesStore,
  milestoneId: IssueMilestoneId,
): IssueProgress {
  return issueMilestoneProgressByMilestone(store).get(milestoneId) ?? EMPTY_ISSUE_PROGRESS;
}

const EMPTY_ISSUE_CATEGORY_COUNTS: ReadonlyMap<IssueStatusCategory, number> = new Map();

/**
 * The same rollup broken out by status category, for a breakdown that has to say how much work is
 * in review rather than only how much is done. Every category the tracker has is counted — nothing
 * here names one — and `canceled` is included, unlike {@link issueMilestoneProgressByMilestone},
 * whose `total` deliberately excludes it. Categories with no issues are absent; read through `?? 0`.
 */
export function issueMilestoneCategoryCounts(
  store: IssuesStore,
): ReadonlyMap<IssueMilestoneId, ReadonlyMap<IssueStatusCategory, number>> {
  const categories = issueStatusCategories(store);
  const counts = new Map<IssueMilestoneId, Map<IssueStatusCategory, number>>();
  for (const milestone of store.milestones) counts.set(milestone.id, new Map());

  for (const issue of store.issuesById.values()) {
    if (issue.milestoneId === null || !isRollupIssue(issue)) continue;
    const bucket = counts.get(issue.milestoneId);
    const category = categories.get(issue.statusId);
    if (bucket === undefined || category === undefined) continue;
    bucket.set(category, (bucket.get(category) ?? 0) + 1);
  }
  return counts;
}

// ── Relations ──────────────────────────────────────────────────────────

/**
 * What a relation row says from the end you are reading it at. Only `blocks` reads differently in
 * the two directions — that is the whole reason the stored row carries a direction rather than
 * materialising an inverse.
 */
export type IssueRelationLabel = "Blocking" | "Blocked by" | "Related" | "Duplicate";

const ISSUE_RELATION_LABEL_ORDER: ReadonlyArray<IssueRelationLabel> = [
  "Blocking",
  "Blocked by",
  "Related",
  "Duplicate",
];

export function issueRelationLabel(edge: IssueRelationEdge): IssueRelationLabel {
  if (edge.relation.kind === "relates") return "Related";
  if (edge.relation.kind === "duplicate") return "Duplicate";
  return edge.direction === "outgoing" ? "Blocking" : "Blocked by";
}

/** The issue at the other end of the row — the one a relation line links to. */
export function issueRelationCounterpartId(edge: IssueRelationEdge): IssueId {
  return edge.direction === "outgoing" ? edge.relation.relatedIssueId : edge.relation.issueId;
}

export interface IssueRelationDisplay {
  readonly relationId: IssueRelationId;
  readonly kind: IssueRelationKind;
  readonly direction: IssueRelationDirection;
  /** The counterpart, never the issue the sheet is showing. */
  readonly issueId: IssueId;
  readonly label: IssueRelationLabel;
}

/** Grouped the way the sheet lists them: blocking first, then blocked by, related, duplicate. */
export function issueRelationDisplays(
  relations: ReadonlyArray<IssueRelationEdge>,
): ReadonlyArray<IssueRelationDisplay> {
  return relations
    .map((edge): IssueRelationDisplay => {
      const label = issueRelationLabel(edge);
      return {
        relationId: edge.relation.id,
        kind: edge.relation.kind,
        direction: edge.direction,
        issueId: issueRelationCounterpartId(edge),
        label,
      };
    })
    .sort(
      (left, right) =>
        ISSUE_RELATION_LABEL_ORDER.indexOf(left.label) -
          ISSUE_RELATION_LABEL_ORDER.indexOf(right.label) ||
        left.issueId.localeCompare(right.issueId),
    );
}

// ── Derived atoms ──────────────────────────────────────────────────────

const issueMilestonesForProjectAtomFamily = Atom.family((projectId: ProjectId) =>
  Atom.make(
    (get): ReadonlyArray<IssueMilestone> =>
      issueMilestonesForProject(get(issuesStoreAtom), projectId),
  ).pipe(Atom.withLabel(`web-issue-milestones:${projectId}`)),
);

const EMPTY_MILESTONES_ATOM = Atom.make(EMPTY_MILESTONES).pipe(
  Atom.withLabel("web-issue-milestones:empty"),
);

const issueChildRollupsAtom = Atom.make(
  (get): ReadonlyMap<IssueId, IssueChildRollup> => issueChildRollups(get(issuesStoreAtom)),
).pipe(Atom.withLabel("web-issue-child-rollups"));

const issueChildRollupAtomFamily = Atom.family((issueId: IssueId) =>
  Atom.make(
    (get): IssueChildRollup => get(issueChildRollupsAtom).get(issueId) ?? EMPTY_ISSUE_CHILD_ROLLUP,
  ).pipe(Atom.withLabel(`web-issue-child-rollup:${issueId}`)),
);

const EMPTY_ISSUE_CHILD_ROLLUP_ATOM = Atom.make(EMPTY_ISSUE_CHILD_ROLLUP).pipe(
  Atom.withLabel("web-issue-child-rollup:empty"),
);

export const issueMilestoneProgressAtom = Atom.make(
  (get): ReadonlyMap<IssueMilestoneId, IssueProgress> =>
    issueMilestoneProgressByMilestone(get(issuesStoreAtom)),
).pipe(Atom.withLabel("web-issue-milestone-progress"));

export const issueMilestoneCategoryCountsAtom = Atom.make(
  (get): ReadonlyMap<IssueMilestoneId, ReadonlyMap<IssueStatusCategory, number>> =>
    issueMilestoneCategoryCounts(get(issuesStoreAtom)),
).pipe(Atom.withLabel("web-issue-milestone-category-counts"));

/**
 * Today is read when the cycles change rather than tracked: a laptop that sits open past midnight
 * re-reads this on the next diff or reconnect, and nothing in the sidebar is worth a timer for.
 */
export const activeCycleAtom = Atom.make((get): IssueCycle | null =>
  activeIssueCycle(get(issueCyclesAtom), todayIssueDate()),
).pipe(Atom.withLabel("web-issue-active-cycle"));

export const upcomingCyclesAtom = Atom.make(
  (get): ReadonlyArray<IssueCycle> => upcomingIssueCycles(get(issueCyclesAtom), todayIssueDate()),
).pipe(Atom.withLabel("web-issue-upcoming-cycles"));

// ── Read hooks ─────────────────────────────────────────────────────────

export function useIssuesStore(): IssuesStore {
  return useAtomValue(issuesStoreAtom);
}

export function useIssuesStoreStatus(): IssuesStoreStatus {
  return useAtomValue(issuesStoreStateAtom).status;
}

export function useIssueStatuses(): ReadonlyArray<IssueStatus> {
  return useAtomValue(issueStatusesAtom);
}

export function useIssueLabels(): ReadonlyArray<IssueLabel> {
  return useAtomValue(issueLabelsAtom);
}

export function useIssueTrackerConfig(): IssueTrackerConfig | null {
  return useAtomValue(issueTrackerConfigAtom);
}

export function useIssuesGrouped(tab: IssuesTab): IssuesGrouping {
  return useAtomValue(issuesGroupedAtomFamily(tab));
}

export function useTriageCount(): number {
  return useAtomValue(triageCountAtom);
}

/** The triage queue itself, newest first. */
export function useTriageIssues(): ReadonlyArray<Issue> {
  return useAtomValue(triageIssuesAtom);
}

export function useSlackWatches(): ReadonlyArray<SlackChannelWatch> {
  return useAtomValue(slackWatchesAtom);
}

export function useSlackStatus(): SlackIntakeStatus {
  return useAtomValue(slackIntakeStatusAtom);
}

/** For a source chip: the channel an issue came in from, named rather than identified. */
export function useSlackChannelNames(): ReadonlyMap<SlackChannelId, string> {
  return useAtomValue(slackChannelNamesAtom);
}

export function useIssue(issueKeyOrId: string | null): Issue | null {
  return useAtomValue(issueKeyOrId === null ? EMPTY_ISSUE_ATOM : issueAtomFamily(issueKeyOrId));
}

/**
 * One subscription for callers that resolve many keys at once. Prefer this over a `useIssue` per
 * key: the count of keys comes from rendered text, and a per-key read would either vary the hook
 * count or grow the atom family without bound.
 *
 * `enabled` is how a caller opts out of the subscription without opting out of the hook — the empty
 * index is a constant atom, so the read count stays fixed and only the atom read varies. Every chat
 * message calls this, and the overwhelming majority mention no key at all: were they all subscribed,
 * an agent moving one issue's status would re-render every message on screen.
 */
export function useIssuesByKey(enabled = true): ReadonlyMap<string, Issue> {
  return useAtomValue(enabled ? issuesByKeyAtom : EMPTY_ISSUES_BY_KEY_ATOM);
}

export function useIssueMilestones(): ReadonlyArray<IssueMilestone> {
  return useAtomValue(issueMilestonesAtom);
}

export function useIssueMilestonesForProject(
  projectId: ProjectId | null,
): ReadonlyArray<IssueMilestone> {
  return useAtomValue(
    projectId === null ? EMPTY_MILESTONES_ATOM : issueMilestonesForProjectAtomFamily(projectId),
  );
}

export function useIssueCycles(): ReadonlyArray<IssueCycle> {
  return useAtomValue(issueCyclesAtom);
}

/** The saved views, in the order the sidebar pins them. */
export function useIssueViews(): ReadonlyArray<IssueView> {
  return useAtomValue(issueViewsAtom);
}

export function useActiveCycle(): IssueCycle | null {
  return useAtomValue(activeCycleAtom);
}

export function useUpcomingCycles(): ReadonlyArray<IssueCycle> {
  return useAtomValue(upcomingCyclesAtom);
}

export function useIssueChildRollup(issueId: IssueId | null): IssueChildRollup {
  return useAtomValue(
    issueId === null ? EMPTY_ISSUE_CHILD_ROLLUP_ATOM : issueChildRollupAtomFamily(issueId),
  );
}

export function useIssueMilestoneProgress(): ReadonlyMap<IssueMilestoneId, IssueProgress> {
  return useAtomValue(issueMilestoneProgressAtom);
}

/** The whole breakdown per milestone. Missing categories mean zero, so read through `?? 0`. */
export function useIssueMilestoneCategoryCounts(): ReadonlyMap<
  IssueMilestoneId,
  ReadonlyMap<IssueStatusCategory, number>
> {
  return useAtomValue(issueMilestoneCategoryCountsAtom);
}

/** One milestone's breakdown, empty until the tracker has both the milestone and its issues. */
export function useIssueMilestoneCategoryCount(
  milestoneId: IssueMilestoneId | null,
): ReadonlyMap<IssueStatusCategory, number> {
  const counts = useAtomValue(issueMilestoneCategoryCountsAtom);
  if (milestoneId === null) return EMPTY_ISSUE_CATEGORY_COUNTS;
  return counts.get(milestoneId) ?? EMPTY_ISSUE_CATEGORY_COUNTS;
}

// ── Change log and detail ──────────────────────────────────────────────

/**
 * Reads rather than streams: both only open in the detail sheet.
 *
 * The change log has no diff on the stream at all, so a write the client made itself has to
 * invalidate it — that is `refreshIssueEvents` below, hung off the commands that append to the log.
 * The tail (todos, relations, comments) does have diffs, so this read is the starting point and
 * {@link mergeIssueDetail} keeps an open sheet current without a second round trip.
 */
const issueEventsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:issues:events",
  tag: ISSUES_WS_METHODS.getEvents,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

const issueDetailQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:issues:detail",
  tag: ISSUES_WS_METHODS.getDetail,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

const issueCommentsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:issues:comments",
  tag: ISSUES_WS_METHODS.commentsList,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

/**
 * The two agent tails. Both are seeds rather than sources of truth: the stream patches them for
 * as long as the panel stays open, which is what makes a transcript live without polling.
 */
const issueEnrichmentRunsQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:issues:enrichment-runs",
  tag: ISSUES_WS_METHODS.getEnrichmentRuns,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

const issueThreadLinksQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:issues:thread-links",
  tag: ISSUES_WS_METHODS.getThreadLinks,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

const issueLinksForThreadQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:issues:links-for-thread",
  tag: ISSUES_WS_METHODS.getIssueLinksForThread,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

const EMPTY_ISSUE_EVENTS: ReadonlyArray<IssueEvent> = Object.freeze([]);
const EMPTY_ISSUE_COMMENTS: ReadonlyArray<IssueComment> = Object.freeze([]);

/** What a sheet needs to render a read that can fail, lag, or be asked for again. */
export interface IssueEventsView {
  readonly events: ReadonlyArray<IssueEvent>;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

export function useIssueEvents(issueId: IssueId | null): IssueEventsView {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const query = useEnvironmentQuery(
    environmentId === null || issueId === null
      ? null
      : issueEventsQuery({ environmentId, input: { issueId } }),
  );
  return {
    events: query.data?.events ?? EMPTY_ISSUE_EVENTS,
    isPending: query.isPending,
    error: query.error,
    refresh: query.refresh,
  };
}

export interface IssueDetailView {
  /** Null until the first read lands; the overlay alone is never enough to render from. */
  readonly detail: IssueDetail | null;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

export function useIssueDetail(issueId: IssueId | null): IssueDetailView {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const query = useEnvironmentQuery(
    environmentId === null || issueId === null
      ? null
      : issueDetailQuery({ environmentId, input: { issueId } }),
  );
  const overlay = useAtomValue(
    issueId === null ? EMPTY_ISSUE_DETAIL_OVERLAY_ATOM : issueDetailOverlayAtomFamily(issueId),
  );
  const detail = useMemo(
    () => (query.data === null ? null : mergeIssueDetail(query.data, overlay)),
    [query.data, overlay],
  );
  return { detail, isPending: query.isPending, error: query.error, refresh: query.refresh };
}

export interface IssueCommentsView {
  readonly comments: ReadonlyArray<IssueComment>;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

/**
 * The comment thread on its own, for a surface that wants it without the rest of the tail. The
 * detail sheet reads {@link useIssueDetail} instead — one round trip, same live patching.
 */
export function useIssueComments(issueId: IssueId | null): IssueCommentsView {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const query = useEnvironmentQuery(
    environmentId === null || issueId === null
      ? null
      : issueCommentsQuery({ environmentId, input: { issueId } }),
  );
  const overlay = useAtomValue(
    issueId === null ? EMPTY_ISSUE_DETAIL_OVERLAY_ATOM : issueDetailOverlayAtomFamily(issueId),
  );
  const comments = useMemo(
    () =>
      query.data === null
        ? EMPTY_ISSUE_COMMENTS
        : mergeIssueDetail({ todos: [], relations: [], comments: query.data.comments }, overlay)
            .comments,
    [query.data, overlay],
  );
  return { comments, isPending: query.isPending, error: query.error, refresh: query.refresh };
}

// ── Agent reads ────────────────────────────────────────────────────────

const EMPTY_ENRICHMENT_RUNS_LIST: ReadonlyArray<IssueEnrichmentRun> = Object.freeze([]);
const EMPTY_THREAD_LINKS: ReadonlyArray<IssueThreadLink> = Object.freeze([]);

export interface IssueEnrichmentRunsView {
  /** Newest first — the panel opens on the latest run and lists the rest as history under it. */
  readonly runs: ReadonlyArray<IssueEnrichmentRun>;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

/**
 * One issue's investigations, live. The read seeds the history; the stream carries the run in
 * flight, transcript and all, so an open panel needs no second round trip and no polling.
 */
export function useIssueEnrichmentRuns(issueId: IssueId | null): IssueEnrichmentRunsView {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const query = useEnvironmentQuery(
    environmentId === null || issueId === null
      ? null
      : issueEnrichmentRunsQuery({ environmentId, input: { issueId } }),
  );
  const patches = useAtomValue(
    issueId === null
      ? EMPTY_ENRICHMENT_RUN_PATCHES_ATOM
      : issueEnrichmentRunPatchesAtomFamily(issueId),
  );
  const runs = useMemo(
    () => mergeIssueEnrichmentRuns(query.data?.runs ?? EMPTY_ENRICHMENT_RUNS_LIST, patches),
    [patches, query.data],
  );
  return { runs, isPending: query.isPending, error: query.error, refresh: query.refresh };
}

export interface IssueThreadLinksView {
  readonly links: ReadonlyArray<IssueThreadLink>;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

/** The threads working an issue. The stream carries the whole list, so a patch replaces outright. */
export function useIssueThreadLinks(issueId: IssueId | null): IssueThreadLinksView {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const query = useEnvironmentQuery(
    environmentId === null || issueId === null
      ? null
      : issueThreadLinksQuery({ environmentId, input: { issueId } }),
  );
  const patch = useAtomValue(
    issueId === null ? EMPTY_THREAD_LINK_PATCH_ATOM : issueThreadLinkPatchAtomFamily(issueId),
  );
  return {
    links: patch ?? query.data?.links ?? EMPTY_THREAD_LINKS,
    isPending: query.isPending,
    error: query.error,
    refresh: query.refresh,
  };
}

/**
 * Reconciles the persisted thread-side read with whole-list stream patches from the issue side.
 * A patch replaces that issue's answer outright, which also makes an unlink disappear immediately.
 */
export function mergeIssueLinksForThread(
  persisted: ReadonlyArray<IssueThreadLink>,
  patchesByIssue: ReadonlyMap<IssueId, ReadonlyArray<IssueThreadLink>>,
  threadId: ThreadId,
): ReadonlyArray<IssueThreadLink> {
  const byIssue = new Map(persisted.map((link) => [link.issueId, link]));
  for (const [issueId, links] of patchesByIssue) {
    const link = links.find((candidate) => candidate.threadId === threadId);
    if (link === undefined) byIssue.delete(issueId);
    else byIssue.set(issueId, link);
  }
  return [...byIssue.values()].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.issueId.localeCompare(right.issueId),
  );
}

export interface IssueLinksForThreadView {
  readonly links: ReadonlyArray<IssueThreadLink>;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

/** Persisted and live issue links for one thread, read from the primary issue-tracker environment. */
export function useIssueLinksForThread(
  threadId: ThreadId | null,
  enabled = true,
): IssueLinksForThreadView {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const query = useEnvironmentQuery(
    environmentId === null || threadId === null || !enabled
      ? null
      : issueLinksForThreadQuery({ environmentId, input: { threadId } }),
  );
  const patchesByIssue = useAtomValue(issueAgentStateAtom).linksByIssue;
  const links = useMemo(
    () =>
      threadId === null
        ? EMPTY_THREAD_LINKS
        : mergeIssueLinksForThread(
            query.data?.links ?? EMPTY_THREAD_LINKS,
            patchesByIssue,
            threadId,
          ),
    [patchesByIssue, query.data, threadId],
  );
  return { links, isPending: query.isPending, error: query.error, refresh: query.refresh };
}

/** For the list and the board: one subscription, membership-stable, no per-row reads. */
export function useInvestigatingIssueIds(): ReadonlySet<IssueId> {
  return useAtomValue(investigatingIssueIdsAtom);
}

/** One subscription for the whole sidebar; avoids a thread-link request per rendered thread. */
export function useStartWorkIssuesByThread(): ReadonlyMap<ThreadId, Issue> {
  return useAtomValue(startWorkIssuesByThreadAtom);
}

/** Runs observed on this connection, used to avoid offering a duplicate investigation by default. */
export function useInvestigatedIssueIds(): ReadonlySet<IssueId> {
  return useAtomValue(investigatedIssueIdsAtom);
}

// ── Milestone history ──────────────────────────────────────────────────

/**
 * The burn-up, reconstructed on the server from the change log and returned as one point per day.
 * A read rather than a stream: it only opens on the milestone detail page, and the store's own
 * diffs already move the live counts beside it — which is exactly why the hook below re-reads when
 * those counts move, so the chart never disagrees with the tiles sitting above it.
 */
const issueMilestoneHistoryQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:issues:milestone-history",
  tag: ISSUES_WS_METHODS.milestoneHistory,
  staleTimeMs: 5_000,
  idleTtlMs: 60_000,
});

const EMPTY_MILESTONE_HISTORY_POINTS: ReadonlyArray<IssueMilestoneHistoryPoint> = Object.freeze([]);

export interface IssueMilestoneHistoryView {
  /** Ascending by date, one per day. Empty for a milestone with no members and no start date. */
  readonly points: ReadonlyArray<IssueMilestoneHistoryPoint>;
  /** A rename left the reconstruction partial. Say so under the chart rather than hiding it. */
  readonly approximate: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly refresh: () => void;
}

/** A cheap fingerprint of one milestone's breakdown, stable across map identity churn. */
function milestoneCategoryCountsKey(counts: ReadonlyMap<IssueStatusCategory, number>): string {
  return [...counts.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([category, count]) => `${category}:${count}`)
    .join(",");
}

export function useIssueMilestoneHistory(
  milestoneId: IssueMilestoneId | null,
): IssueMilestoneHistoryView {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const query = useEnvironmentQuery(
    environmentId === null || milestoneId === null
      ? null
      : issueMilestoneHistoryQuery({ environmentId, input: { milestoneId } }),
  );

  // The series is a read, not a stream, so an issue joining the milestone, leaving it, or changing
  // category while the page stays open would otherwise leave the chart on the shape it had when the
  // page opened, disagreeing with the tiles beside it. The breakdown is built from the same issues
  // the series is, so it moves exactly when the chart would and never on an unrelated edit. The ref
  // holds the first fingerprint rather than acting on it: the query has already read it.
  const countsKey = milestoneCategoryCountsKey(useIssueMilestoneCategoryCount(milestoneId));
  const seenCountsKey = useRef<string | null>(null);
  const refetch = useEffectEvent(() => query.refresh());
  useEffect(() => {
    if (milestoneId === null) {
      seenCountsKey.current = null;
      return;
    }
    const seen = seenCountsKey.current;
    seenCountsKey.current = countsKey;
    if (seen === null || seen === countsKey) return;
    refetch();
  }, [countsKey, milestoneId]);

  return {
    points: query.data?.points ?? EMPTY_MILESTONE_HISTORY_POINTS,
    approximate: query.data?.approximate ?? false,
    isPending: query.isPending,
    error: query.error,
    refresh: query.refresh,
  };
}

// ── Mutations ──────────────────────────────────────────────────────────

export class IssueTrackerUnavailableError extends Data.TaggedError("IssueTrackerUnavailableError")<{
  readonly message: string;
}> {}

const issueCommandScheduler = createAtomCommandScheduler();

/**
 * Serial per environment. Every write appends to the change log and several republish the whole
 * status or label set, so two writes racing would order the feed by whichever query returned
 * first and could publish the older set last.
 */
const serialPerEnvironment = {
  mode: "serial",
  key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
} as const;

const writeCommandOptions = {
  scheduler: issueCommandScheduler,
  concurrency: serialPerEnvironment,
} as const;

/**
 * The issues a write names, read off its input rather than its result: `onSuccess` runs before the
 * caller sees the answer, and every input that concerns an existing issue names it the same three
 * ways. A create names none, which is right — nothing is reading a new issue's log yet.
 */
export function issueIdsNamedByCommandInput(input: unknown): ReadonlyArray<IssueId> {
  if (typeof input !== "object" || input === null) return [];
  const named = input as {
    readonly issueId?: unknown;
    readonly relatedIssueId?: unknown;
    readonly issueIds?: unknown;
  };
  const issueIds: Array<IssueId> = [];
  if (typeof named.issueId === "string") issueIds.push(named.issueId as IssueId);
  if (typeof named.relatedIssueId === "string") issueIds.push(named.relatedIssueId as IssueId);
  if (Array.isArray(named.issueIds)) {
    for (const issueId of named.issueIds as ReadonlyArray<unknown>) {
      if (typeof issueId === "string") issueIds.push(issueId as IssueId);
    }
  }
  return issueIds;
}

/**
 * The change log is the one read with no diff on the stream, so a write has to invalidate it. This
 * is the house `registry.refresh` idiom (`state/usage.ts:103`, `state/queries.ts:211`) rather than
 * a bump atom: refreshing an unmounted query only marks it stale, so this costs a round trip
 * exactly when a sheet is open on the issue that changed and nothing otherwise.
 */
const refreshIssueEvents = (
  target: { readonly environmentId: EnvironmentId; readonly input: unknown },
  registry: AtomRegistry.AtomRegistry,
): Effect.Effect<void> =>
  Effect.sync(() => {
    for (const issueId of issueIdsNamedByCommandInput(target.input)) {
      registry.refresh(
        issueEventsQuery({ environmentId: target.environmentId, input: { issueId } }),
      );
    }
  });

/**
 * For the writes that append to the change log. Todos and comments deliberately do not — the
 * server says so in `persistence/Services/IssueTodos.ts` — so they keep the plain options and skip
 * a refetch that would find the feed unchanged.
 *
 * `relationDelete` is the one write that logs and is still plain: `IssueRelationDeleteInput` names
 * only the relation, so {@link issueIdsNamedByCommandInput} has nothing to key a refresh on, and
 * `onSuccess` cannot see the result that does carry both ends. `IssueDetailSheet` refreshes its own
 * feed at the call site instead. `relationCreate` needs none of that — its input names both issues.
 */
const loggedWriteCommandOptions = {
  ...writeCommandOptions,
  onSuccess: refreshIssueEvents,
} as const;

export const issueCommands = {
  create: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:create",
    tag: ISSUES_WS_METHODS.create,
    ...loggedWriteCommandOptions,
  }),
  update: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:update",
    tag: ISSUES_WS_METHODS.update,
    ...loggedWriteCommandOptions,
  }),
  delete: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:delete",
    tag: ISSUES_WS_METHODS.delete,
    ...loggedWriteCommandOptions,
  }),
  restore: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:restore",
    tag: ISSUES_WS_METHODS.restore,
    ...loggedWriteCommandOptions,
  }),
  bulkUpdate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:bulk-update",
    tag: ISSUES_WS_METHODS.bulkUpdate,
    ...loggedWriteCommandOptions,
  }),
  setSortOrder: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:set-sort-order",
    tag: ISSUES_WS_METHODS.setSortOrder,
    ...loggedWriteCommandOptions,
  }),
  createStatus: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:create-status",
    tag: ISSUES_WS_METHODS.createStatus,
    ...loggedWriteCommandOptions,
  }),
  updateStatus: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:update-status",
    tag: ISSUES_WS_METHODS.updateStatus,
    ...loggedWriteCommandOptions,
  }),
  deleteStatus: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:delete-status",
    tag: ISSUES_WS_METHODS.deleteStatus,
    ...loggedWriteCommandOptions,
  }),
  reorderStatuses: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:reorder-statuses",
    tag: ISSUES_WS_METHODS.reorderStatuses,
    ...loggedWriteCommandOptions,
  }),
  createLabel: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:create-label",
    tag: ISSUES_WS_METHODS.createLabel,
    ...loggedWriteCommandOptions,
  }),
  updateLabel: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:update-label",
    tag: ISSUES_WS_METHODS.updateLabel,
    ...loggedWriteCommandOptions,
  }),
  deleteLabel: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:delete-label",
    tag: ISSUES_WS_METHODS.deleteLabel,
    ...loggedWriteCommandOptions,
  }),
  setKeyPrefix: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:set-key-prefix",
    tag: ISSUES_WS_METHODS.setKeyPrefix,
    ...loggedWriteCommandOptions,
  }),
  importCsv: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:import-csv",
    tag: ISSUES_WS_METHODS.importCsv,
    ...loggedWriteCommandOptions,
  }),
  milestoneCreate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:milestone-create",
    tag: ISSUES_WS_METHODS.milestoneCreate,
    ...loggedWriteCommandOptions,
  }),
  milestoneUpdate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:milestone-update",
    tag: ISSUES_WS_METHODS.milestoneUpdate,
    ...loggedWriteCommandOptions,
  }),
  milestoneDelete: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:milestone-delete",
    tag: ISSUES_WS_METHODS.milestoneDelete,
    ...loggedWriteCommandOptions,
  }),
  milestonesReorder: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:milestones-reorder",
    tag: ISSUES_WS_METHODS.milestonesReorder,
    ...loggedWriteCommandOptions,
  }),
  cycleCreate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:cycle-create",
    tag: ISSUES_WS_METHODS.cycleCreate,
    ...loggedWriteCommandOptions,
  }),
  cycleUpdate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:cycle-update",
    tag: ISSUES_WS_METHODS.cycleUpdate,
    ...loggedWriteCommandOptions,
  }),
  cycleDelete: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:cycle-delete",
    tag: ISSUES_WS_METHODS.cycleDelete,
    ...loggedWriteCommandOptions,
  }),
  todoCreate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:todo-create",
    tag: ISSUES_WS_METHODS.todoCreate,
    ...writeCommandOptions,
  }),
  todoUpdate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:todo-update",
    tag: ISSUES_WS_METHODS.todoUpdate,
    ...writeCommandOptions,
  }),
  todoDelete: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:todo-delete",
    tag: ISSUES_WS_METHODS.todoDelete,
    ...writeCommandOptions,
  }),
  todosReorder: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:todos-reorder",
    tag: ISSUES_WS_METHODS.todosReorder,
    ...writeCommandOptions,
  }),
  relationCreate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:relation-create",
    tag: ISSUES_WS_METHODS.relationCreate,
    ...loggedWriteCommandOptions,
  }),
  /** Names only the row, so neither end can be refreshed from the input; the sheet's own diff
      covers the relation list and the feed catches up on its next read. */
  relationDelete: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:relation-delete",
    tag: ISSUES_WS_METHODS.relationDelete,
    ...writeCommandOptions,
  }),
  commentCreate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:comment-create",
    tag: ISSUES_WS_METHODS.commentCreate,
    ...writeCommandOptions,
  }),
  commentUpdate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:comment-update",
    tag: ISSUES_WS_METHODS.commentUpdate,
    ...writeCommandOptions,
  }),
  commentDelete: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:comment-delete",
    tag: ISSUES_WS_METHODS.commentDelete,
    ...writeCommandOptions,
  }),
  /**
   * The two mention-run controls. Both answer with the origin comment, and both republish it on
   * the stream as an `IssueCommentUpserted` — so neither needs an overlay here: the run's new
   * state arrives the same way its first one did.
   */
  cancelCommentAgentRun: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:cancel-comment-agent-run",
    tag: ISSUES_WS_METHODS.cancelCommentAgentRun,
    ...writeCommandOptions,
  }),
  retryCommentAgentRun: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:retry-comment-agent-run",
    tag: ISSUES_WS_METHODS.retryCommentAgentRun,
    ...writeCommandOptions,
  }),
  /** Writes bytes rather than rows, so it appends to no change log and publishes no diff. */
  uploadCommentAttachment: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:upload-comment-attachment",
    tag: ISSUES_WS_METHODS.uploadCommentAttachment,
    ...writeCommandOptions,
  }),
  /** Views are a lens on the tracker: nothing about an issue moved, so nothing logs. */
  viewCreate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:view-create",
    tag: ISSUES_WS_METHODS.viewCreate,
    ...writeCommandOptions,
  }),
  viewUpdate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:view-update",
    tag: ISSUES_WS_METHODS.viewUpdate,
    ...writeCommandOptions,
  }),
  viewDelete: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:view-delete",
    tag: ISSUES_WS_METHODS.viewDelete,
    ...writeCommandOptions,
  }),
  viewsReorder: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:views-reorder",
    tag: ISSUES_WS_METHODS.viewsReorder,
    ...writeCommandOptions,
  }),
  /**
   * Starting a run logs nothing: the row that lands in the change log is the description append a
   * finished run makes, minutes later, and no refresh here could anticipate it. The panel
   * refreshes the feed when it sees a run reach `done`.
   */
  startEnrichment: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:start-enrichment",
    tag: ISSUES_WS_METHODS.startEnrichment,
    ...writeCommandOptions,
  }),
  /** Names only the run, so there is no issue id to key a feed refresh on — and none is logged. */
  cancelEnrichment: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:cancel-enrichment",
    tag: ISSUES_WS_METHODS.cancelEnrichment,
    ...writeCommandOptions,
  }),
  linkThread: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:link-thread",
    tag: ISSUES_WS_METHODS.linkThread,
    ...loggedWriteCommandOptions,
  }),
  unlinkThread: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:unlink-thread",
    tag: ISSUES_WS_METHODS.unlinkThread,
    ...loggedWriteCommandOptions,
  }),
  /**
   * Intake. None of the four writes touches an issue, so none appends to a change log: they
   * configure the poller, and the poller's own writes are what land in a feed.
   */
  slackSetToken: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:slack-set-token",
    tag: ISSUES_WS_METHODS.slackSetToken,
    ...writeCommandOptions,
  }),
  /**
   * A read, but an imperative one: the picker asks Slack when it opens rather than on every
   * render, and a second press while one is in flight should join it rather than start another.
   */
  slackListChannels: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:slack-list-channels",
    tag: ISSUES_WS_METHODS.slackListChannels,
    scheduler: issueCommandScheduler,
    concurrency: {
      mode: "singleFlight",
      key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
    },
  }),
  slackWatchCreate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:slack-watch-create",
    tag: ISSUES_WS_METHODS.slackWatchCreate,
    ...writeCommandOptions,
  }),
  slackWatchUpdate: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:slack-watch-update",
    tag: ISSUES_WS_METHODS.slackWatchUpdate,
    ...writeCommandOptions,
  }),
  slackWatchDelete: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:slack-watch-delete",
    tag: ISSUES_WS_METHODS.slackWatchDelete,
    ...writeCommandOptions,
  }),
  /** Both write `issue_events` rows — status, project, priority, triage — so both refresh a feed. */
  triageAccept: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:triage-accept",
    tag: ISSUES_WS_METHODS.triageAccept,
    ...loggedWriteCommandOptions,
  }),
  triageReject: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "environment-data:issues:triage-reject",
    tag: ISSUES_WS_METHODS.triageReject,
    ...loggedWriteCommandOptions,
  }),
} as const;

type IssueCommandInput<C> =
  C extends AtomCommand<infer W, infer _A, infer _E>
    ? W extends { readonly input: infer I }
      ? I
      : never
    : never;
type IssueCommandSuccess<C> = C extends AtomCommand<infer _W, infer A, infer _E> ? A : never;
type IssueCommandFailure<C> = C extends AtomCommand<infer _W, infer _A, infer E> ? E : never;

/**
 * Binds a write to the primary environment. Nothing here takes an environment: the tracker only
 * exists on the machine you are connected to, and there is no cross-environment view of it.
 */
function usePrimaryIssueCommand<
  C extends AtomCommand<
    { readonly environmentId: EnvironmentId; readonly input: never },
    unknown,
    unknown
  >,
>(
  command: C,
): (
  input: IssueCommandInput<C>,
) => Promise<
  AtomCommandResult<IssueCommandSuccess<C>, IssueCommandFailure<C> | IssueTrackerUnavailableError>
> {
  const environmentId = useAtomValue(primaryEnvironmentIdAtom);
  const run = useAtomCommand(
    command as unknown as AtomCommand<
      { readonly environmentId: EnvironmentId; readonly input: IssueCommandInput<C> },
      IssueCommandSuccess<C>,
      IssueCommandFailure<C>
    >,
  );
  return useCallback(
    (input: IssueCommandInput<C>) =>
      environmentId === null
        ? Promise.resolve(
            AsyncResult.fail<IssueTrackerUnavailableError, IssueCommandSuccess<C>>(
              new IssueTrackerUnavailableError({
                message: "No environment is connected, so the issue tracker cannot be written to.",
              }),
            ),
          )
        : run({ environmentId, input }),
    [environmentId, run],
  );
}

export const useCreateIssue = () => usePrimaryIssueCommand(issueCommands.create);
export const useUpdateIssue = () => usePrimaryIssueCommand(issueCommands.update);
export const useDeleteIssue = () => usePrimaryIssueCommand(issueCommands.delete);
export const useRestoreIssue = () => usePrimaryIssueCommand(issueCommands.restore);
export const useBulkUpdateIssues = () => usePrimaryIssueCommand(issueCommands.bulkUpdate);
export const useSetIssueSortOrder = () => usePrimaryIssueCommand(issueCommands.setSortOrder);
export const useCreateIssueStatus = () => usePrimaryIssueCommand(issueCommands.createStatus);
export const useUpdateIssueStatus = () => usePrimaryIssueCommand(issueCommands.updateStatus);
export const useDeleteIssueStatus = () => usePrimaryIssueCommand(issueCommands.deleteStatus);
export const useReorderIssueStatuses = () => usePrimaryIssueCommand(issueCommands.reorderStatuses);
export const useCreateIssueLabel = () => usePrimaryIssueCommand(issueCommands.createLabel);
export const useUpdateIssueLabel = () => usePrimaryIssueCommand(issueCommands.updateLabel);
export const useDeleteIssueLabel = () => usePrimaryIssueCommand(issueCommands.deleteLabel);
export const useSetIssueKeyPrefix = () => usePrimaryIssueCommand(issueCommands.setKeyPrefix);
export const useImportIssuesCsv = () => usePrimaryIssueCommand(issueCommands.importCsv);
export const useCreateIssueMilestone = () => usePrimaryIssueCommand(issueCommands.milestoneCreate);
export const useUpdateIssueMilestone = () => usePrimaryIssueCommand(issueCommands.milestoneUpdate);
export const useDeleteIssueMilestone = () => usePrimaryIssueCommand(issueCommands.milestoneDelete);
export const useReorderIssueMilestones = () =>
  usePrimaryIssueCommand(issueCommands.milestonesReorder);
export const useCreateIssueCycle = () => usePrimaryIssueCommand(issueCommands.cycleCreate);
export const useUpdateIssueCycle = () => usePrimaryIssueCommand(issueCommands.cycleUpdate);
export const useDeleteIssueCycle = () => usePrimaryIssueCommand(issueCommands.cycleDelete);
export const useCreateIssueTodo = () => usePrimaryIssueCommand(issueCommands.todoCreate);
export const useUpdateIssueTodo = () => usePrimaryIssueCommand(issueCommands.todoUpdate);
export const useDeleteIssueTodo = () => usePrimaryIssueCommand(issueCommands.todoDelete);
export const useReorderIssueTodos = () => usePrimaryIssueCommand(issueCommands.todosReorder);
export const useCreateIssueRelation = () => usePrimaryIssueCommand(issueCommands.relationCreate);
export const useDeleteIssueRelation = () => usePrimaryIssueCommand(issueCommands.relationDelete);
export const useCreateIssueComment = () => usePrimaryIssueCommand(issueCommands.commentCreate);
export const useUpdateIssueComment = () => usePrimaryIssueCommand(issueCommands.commentUpdate);
export const useDeleteIssueComment = () => usePrimaryIssueCommand(issueCommands.commentDelete);
/** Both name the origin comment: a comment carries at most one run, so there is no run id to send. */
export const useCancelIssueCommentAgentRun = () =>
  usePrimaryIssueCommand(issueCommands.cancelCommentAgentRun);
export const useRetryIssueCommentAgentRun = () =>
  usePrimaryIssueCommand(issueCommands.retryCommentAgentRun);
export const useUploadIssueCommentAttachment = () =>
  usePrimaryIssueCommand(issueCommands.uploadCommentAttachment);
export const useCreateIssueView = () => usePrimaryIssueCommand(issueCommands.viewCreate);
export const useUpdateIssueView = () => usePrimaryIssueCommand(issueCommands.viewUpdate);
export const useDeleteIssueView = () => usePrimaryIssueCommand(issueCommands.viewDelete);
export const useReorderIssueViews = () => usePrimaryIssueCommand(issueCommands.viewsReorder);
export const useStartIssueEnrichment = () => usePrimaryIssueCommand(issueCommands.startEnrichment);
export const useCancelIssueEnrichment = () =>
  usePrimaryIssueCommand(issueCommands.cancelEnrichment);
export const useLinkIssueThread = () => usePrimaryIssueCommand(issueCommands.linkThread);
export const useUnlinkIssueThread = () => usePrimaryIssueCommand(issueCommands.unlinkThread);
/** An empty token disconnects; the server tests the connection before it writes either way. */
export const useSlackSetToken = () => usePrimaryIssueCommand(issueCommands.slackSetToken);
export const useSlackListChannels = () => usePrimaryIssueCommand(issueCommands.slackListChannels);
export const useCreateSlackWatch = () => usePrimaryIssueCommand(issueCommands.slackWatchCreate);
export const useUpdateSlackWatch = () => usePrimaryIssueCommand(issueCommands.slackWatchUpdate);
export const useDeleteSlackWatch = () => usePrimaryIssueCommand(issueCommands.slackWatchDelete);
export const useTriageAccept = () => usePrimaryIssueCommand(issueCommands.triageAccept);
export const useTriageReject = () => usePrimaryIssueCommand(issueCommands.triageReject);

// ── Drag ordering ──────────────────────────────────────────────────────

/**
 * The same base-26 fractional key the sidebar's pinned reorder writes, and the same algorithm the
 * server duplicates in `apps/server/src/issues/sortOrder.ts` — one drag writes ONE key to ONE
 * row, so neighbours are never rewritten and two clients that drop a row in the same place
 * converge.
 */
export { pinOrderKeyBetween as issueSortOrderBetween } from "@spiritdevs/client-runtime/state/thread-sort";

/**
 * The key a dropped row takes. `siblings` is the destination group in display order with the
 * dragged row already removed, and `index` is the slot it lands in (`siblings.length` appends).
 *
 * Null when a neighbouring key is unusable, which only happens if a key was hand-edited in the
 * database: the caller should refuse the write rather than break the total order.
 */
export function issueSortOrderForDrop(input: {
  readonly siblings: ReadonlyArray<{ readonly sortOrder: string }>;
  readonly index: number;
}): string | null {
  const index = Math.max(0, Math.min(input.index, input.siblings.length));
  const before = index > 0 ? (input.siblings[index - 1]?.sortOrder ?? null) : null;
  const after = index < input.siblings.length ? (input.siblings[index]?.sortOrder ?? null) : null;
  return pinOrderKeyBetween(before, after);
}
