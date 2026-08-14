/**
 * Pure decisions behind the issue detail sheet — see
 * `docs/internals/decisions/0006-issue-tracker.md`.
 *
 * Two jobs live here. One is turning a `issue_events` row into a sentence: the log stores display
 * values rather than ids so it reads back after the referenced row is gone, but it stores them raw
 * (`agent:codex`, `yes`, a bare `ProjectId`), and the feed has to say what a person would say. The
 * other is patch assembly: every editor in the sheet answers with an `IssuePatch` or with null
 * meaning "nothing moved", so the sheet never writes a no-op and never has to compare fields at
 * the call site.
 *
 * @module components/issues/issueDetail.logic
 */
import { ISSUE_MAX_PARENT_DEPTH } from "@t3tools/contracts";
import type {
  Issue,
  IssueAssignee,
  IssueComment,
  IssueCommentPatch,
  IssueCycleId,
  IssueDate,
  IssueEvent,
  IssueId,
  IssueLabelId,
  IssueMilestoneId,
  IssuePatch,
  IssuePriority,
  IssueRelationCreateInput,
  IssueRelationKind,
  IssueStatusId,
  IssueTodo,
  IssueTodoId,
  IssueTodoPatch,
  ProjectId,
  ProviderDriverKind,
} from "@t3tools/contracts";

import type {
  IssueProgress,
  IssueRelationDisplay,
  IssueRelationLabel,
  IssuesStoreStatus,
} from "~/state/issues";
import {
  ISSUE_ASSIGNEE_AGENT_PREFIX,
  ISSUE_ASSIGNEE_MEMBER_PREFIX,
  ISSUE_ASSIGNEE_USER_VALUE,
  ISSUE_PRIORITY_LABELS,
  issueAssigneeValue,
  toggleIssueLabelIds,
} from "./issuesList.logic";

// ── Sheet state ────────────────────────────────────────────────────────

/**
 * What the sheet shows for a `?issue=` that has not resolved to a row.
 *
 * `settled` is the caller's answer to "has the opening replay finished arriving?". The stream has
 * no snapshot variant, so the store reports `ready` on its first chunk and a deep link into a
 * tracker whose replay is still landing would otherwise flash "not found" before its issue
 * appears.
 */
export type IssueDetailState = "disconnected" | "loading" | "not-found" | "ready";

export function resolveIssueDetailState(input: {
  readonly storeStatus: IssuesStoreStatus;
  readonly issue: Issue | null;
  readonly settled: boolean;
}): IssueDetailState {
  // A soft-deleted row is still in the store — it has to be, for the depth cap — but a deep link
  // to one has nothing to show. "Not found" is what the sheet said before deletes left tombstones,
  // and its copy already offers "it may have been deleted" as the reason.
  if (input.issue !== null && input.issue.deletedAt === null) return "ready";
  if (input.storeStatus === "disconnected") return "disconnected";
  if (input.storeStatus === "loading") return "loading";
  return input.settled ? "not-found" : "loading";
}

// ── Assignee ───────────────────────────────────────────────────────────

/** The empty option's value; a `<MenuRadioGroup>` cannot carry null. */
export const ISSUE_ASSIGNEE_NONE_VALUE = "";

export interface IssueAssigneeOption {
  readonly value: string;
  readonly label: string;
  readonly assignee: IssueAssignee | null;
}

/**
 * Unassigned, the one human on this environment, then a row per configured provider. Assignment
 * records intent only — an assigned agent surfaces a "Start work" button rather than a turn — so
 * every provider is offerable whether or not it happens to be running.
 */
export function issueAssigneeOptions(
  providers: ReadonlyArray<{ readonly value: ProviderDriverKind; readonly label: string }>,
): ReadonlyArray<IssueAssigneeOption> {
  return [
    { value: ISSUE_ASSIGNEE_NONE_VALUE, label: "Unassigned", assignee: null },
    { value: ISSUE_ASSIGNEE_USER_VALUE, label: "You", assignee: { kind: "user" } },
    ...providers.map((provider) => ({
      value: `${ISSUE_ASSIGNEE_AGENT_PREFIX}${provider.value}`,
      label: provider.label,
      assignee: { kind: "agent", provider: provider.value } as const,
    })),
  ];
}

export function issueAssigneeOptionValue(assignee: IssueAssignee | null): string {
  return issueAssigneeValue(assignee) ?? ISSUE_ASSIGNEE_NONE_VALUE;
}

/** Two assignees are the same when they name the same actor, not when they are the same object. */
export function sameIssueAssignee(
  left: IssueAssignee | null,
  right: IssueAssignee | null,
): boolean {
  return issueAssigneeOptionValue(left) === issueAssigneeOptionValue(right);
}

// ── Patch assembly ─────────────────────────────────────────────────────

/**
 * Null means "nothing to write". Every editor in the sheet fires on blur or on a menu press, and
 * both of those happen constantly without the value having moved.
 */
export function issueTitlePatch(issue: Issue, raw: string): IssuePatch | null {
  const title = raw.trim();
  // An empty title is a rejected edit, not a clear: the field is non-empty in the contract, so
  // the caller restores the old text rather than sending a write the server will refuse.
  if (title.length === 0 || title === issue.title) return null;
  return { title };
}

export function issueDescriptionPatch(issue: Issue, next: string): IssuePatch | null {
  return next === issue.description ? null : { description: next };
}

export function issueStatusPatch(issue: Issue, statusId: IssueStatusId): IssuePatch | null {
  return statusId === issue.statusId ? null : { statusId };
}

export function issuePriorityPatch(issue: Issue, priority: IssuePriority): IssuePatch | null {
  return priority === issue.priority ? null : { priority };
}

export function issueAssigneePatch(
  issue: Issue,
  assignee: IssueAssignee | null,
): IssuePatch | null {
  return sameIssueAssignee(assignee, issue.assignee) ? null : { assignee };
}

export function issueProjectPatch(issue: Issue, projectId: ProjectId | null): IssuePatch | null {
  return projectId === issue.projectId ? null : { projectId };
}

export function issueLabelTogglePatch(issue: Issue, labelId: IssueLabelId): IssuePatch {
  return { labelIds: toggleIssueLabelIds(issue.labelIds, labelId) };
}

export function issueMilestonePatch(
  issue: Issue,
  milestoneId: IssueMilestoneId | null,
): IssuePatch | null {
  return milestoneId === issue.milestoneId ? null : { milestoneId };
}

export function issueCyclePatch(issue: Issue, cycleId: IssueCycleId | null): IssuePatch | null {
  return cycleId === issue.cycleId ? null : { cycleId };
}

/**
 * Refuses a parent the server would refuse anyway — itself — so the one press that cannot work
 * never leaves the client. Depth and cycles are the picker's job: it only offers candidates
 * {@link canParentIssue} accepts.
 */
export function issueParentPatch(issue: Issue, parentId: IssueId | null): IssuePatch | null {
  if (parentId === issue.id) return null;
  return parentId === issue.parentId ? null : { parentId };
}

/** What a `<input type="date">` shows: the stored calendar day, or nothing. */
export function issueDueDateInputValue(issue: Issue): string {
  return issue.dueDate ?? "";
}

const ISSUE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Whether a `<input type="date">` value is a whole day rather than a half-typed one. A native date
 * field reports `""` for every incomplete state, so a commit on every keystroke would read the
 * middle of "type 20 Aug" as "clear the due date" — this is what says to wait for the blur.
 */
export function isCompleteIssueDate(raw: string): boolean {
  return ISSUE_DATE_PATTERN.test(raw.trim());
}

/**
 * An empty field clears the date; anything the native picker cannot produce is refused rather
 * than sent, because a half-typed year arrives here as `0002-08-12`.
 */
export function issueDueDatePatch(issue: Issue, raw: string): IssuePatch | null {
  const value = raw.trim();
  if (value.length === 0) return issue.dueDate === null ? null : { dueDate: null };
  if (!isCompleteIssueDate(value)) return null;
  const dueDate = value as IssueDate;
  return dueDate === issue.dueDate ? null : { dueDate };
}

// ── Activity feed ──────────────────────────────────────────────────────

export interface IssueEventNaming {
  /** `project` events carry a raw `ProjectId`, which is a nanoid, not a name. */
  readonly projectTitles?: ReadonlyMap<string, string> | undefined;
  readonly providerLabels?: ReadonlyMap<string, string> | undefined;
  /**
   * A `member` actor carries a `MembershipId`, which is an id and not a name. Keyed by membership
   * rather than by person because attribution outlives a departure: the tombstoned membership is
   * still what the row points at.
   */
  readonly memberNames?: ReadonlyMap<string, string> | undefined;
  /** `parent` events carry a raw `IssueId`; the key is what a human recognises. */
  readonly issueKeys?: ReadonlyMap<string, string> | undefined;
}

export interface IssueEventDescription {
  readonly actor: string;
  /** Reads as the continuation of the actor: "Claude" + "changed status from Todo to In Progress". */
  readonly summary: string;
}

const EMPTY_NAMING: IssueEventNaming = {};

/**
 * A record rather than a ternary so the compiler names a source nobody labelled. The union grew a
 * `cycles` member with the lazy carry-over and an "everything that is not an import is Slack"
 * branch silently attributed the tracker's own write to a Slack bot that had not been built yet.
 */
const ISSUE_SYSTEM_ACTOR_LABELS: Readonly<
  Record<Extract<IssueEvent["actor"], { kind: "system" }>["source"], string>
> = {
  import: "CSV import",
  // Not a person and not the tracker in general: the one write nobody asked for is a cycle ending.
  cycles: "Cycle rollover",
  slack: "Slack",
  automation: "Automation",
};

export function issueActorLabel(
  actor: IssueEvent["actor"],
  naming: IssueEventNaming = EMPTY_NAMING,
): string {
  switch (actor.kind) {
    case "user":
      return "You";
    // A teammate reads as a person, never as the company: the membership is the fallback name for
    // the same reason the provider slug is an agent's, so two people never share one line.
    case "member":
      return naming.memberNames?.get(actor.membershipId) ?? actor.membershipId;
    case "agent":
      return naming.providerLabels?.get(actor.provider) ?? actor.provider;
    case "system":
      return ISSUE_SYSTEM_ACTOR_LABELS[actor.source];
  }
}

function quote(value: string): string {
  return `“${value}”`;
}

/**
 * `agent:codex`, `member:<membershipId>` and `user` are how the log stores an assignee; none of
 * them is a sentence.
 */
function assigneeEventLabel(value: string | null, naming: IssueEventNaming): string | null {
  if (value === null || value.length === 0) return null;
  if (value === ISSUE_ASSIGNEE_USER_VALUE) return "you";
  if (value.startsWith(ISSUE_ASSIGNEE_AGENT_PREFIX)) {
    const provider = value.slice(ISSUE_ASSIGNEE_AGENT_PREFIX.length);
    return naming.providerLabels?.get(provider) ?? provider;
  }
  if (value.startsWith(ISSUE_ASSIGNEE_MEMBER_PREFIX)) {
    const membershipId = value.slice(ISSUE_ASSIGNEE_MEMBER_PREFIX.length);
    return naming.memberNames?.get(membershipId) ?? membershipId;
  }
  return value;
}

const PRIORITY_LABEL_BY_VALUE: Readonly<Record<string, string | undefined>> = ISSUE_PRIORITY_LABELS;

function priorityEventLabel(value: string | null): string | null {
  if (value === null || value.length === 0) return null;
  return PRIORITY_LABEL_BY_VALUE[value] ?? value;
}

function nonEmpty(value: string | null): string | null {
  return value === null || value.length === 0 ? null : value;
}

function fromTo(field: string, before: string | null, after: string | null): string {
  if (after === null) return `cleared the ${field}`;
  if (before === null) return `set the ${field} to ${after}`;
  return `changed ${field} from ${before} to ${after}`;
}

function describeFieldChange(event: IssueEvent, naming: IssueEventNaming): string {
  const before = nonEmpty(event.before);
  const after = nonEmpty(event.after);
  switch (event.field) {
    case "title":
      return after === null ? "changed the title" : `renamed this to ${quote(after)}`;
    case "description":
      // The log truncates a body at 512 characters, so quoting either side is a wall of text
      // pretending to be a diff.
      return "updated the description";
    case "status":
      return fromTo("status", before, after);
    case "priority":
      return fromTo("priority", priorityEventLabel(before), priorityEventLabel(after));
    case "assignee": {
      const assigned = assigneeEventLabel(after, naming);
      return assigned === null ? "unassigned this" : `assigned this to ${assigned}`;
    }
    case "project": {
      const title = after === null ? null : (naming.projectTitles?.get(after) ?? after);
      return title === null ? "removed this from its project" : `moved this to ${title}`;
    }
    case "parent": {
      const key = after === null ? null : (naming.issueKeys?.get(after) ?? after);
      return key === null ? "cleared the parent issue" : `made this a sub-issue of ${key}`;
    }
    case "dueDate":
      return fromTo("due date", before, after);
    // The log stores milestone and cycle *names*, not ids, so these read back after the milestone
    // or cycle they name is gone — which is exactly when a carry-over is worth reading.
    case "milestone":
      return fromTo("milestone", before, after);
    case "cycle":
      return fromTo("cycle", before, after);
    case "relation": {
      // Not a from/to: the log holds one whole phrase per side ("blocks PAT-12", "blocked by
      // PAT-12"), already read from this issue's end, and a relation is only ever added or removed.
      if (after !== null) return `added the relation ${quote(after)}`;
      return before === null ? "changed the relations" : `removed the relation ${quote(before)}`;
    }
    case "pullRequest":
      return after === null
        ? "cleared the linked pull request"
        : before === null
          ? `linked pull request ${after}`
          : `replaced pull request ${before} with ${after}`;
    case "triage":
      return after === "yes" ? "moved this into triage" : "accepted this out of triage";
    case "labels": {
      if (after === null) return "removed every label";
      return before === null ? `added the labels ${after}` : `changed labels to ${after}`;
    }
    case null:
      return "changed this issue";
    default:
      return `changed ${event.field}`;
  }
}

export function describeIssueEvent(
  event: IssueEvent,
  naming: IssueEventNaming = EMPTY_NAMING,
): IssueEventDescription {
  const actor = issueActorLabel(event.actor, naming);
  switch (event.kind) {
    case "created":
      return { actor, summary: "created this issue" };
    case "imported":
      return { actor, summary: "imported this issue" };
    case "deleted":
      return { actor, summary: "deleted this issue" };
    case "restored":
      return { actor, summary: "restored this issue" };
    // A soft delete underneath, but "this never was an issue" is the ordinary outcome of intake
    // and should not read in the feed as somebody destroying work.
    case "triage_rejected":
      return { actor, summary: "rejected this triage item" };
    case "field_changed":
      return { actor, summary: describeFieldChange(event, naming) };
  }
}

/**
 * Oldest first, which is the order the repository returns and the order a story is told in.
 *
 * Ties keep the order they arrived in rather than breaking on id: one edit that moves three fields
 * writes three rows on the same millisecond, and the repository already orders those by rowid —
 * their write order (`IssueEvents.ts:71`). Ids are random uuids, so tiebreaking on one would sort
 * "renamed / changed status / changed priority" into nonsense. `Array.prototype.sort` is stable,
 * so dropping the tiebreak is what preserves the server's order without making it unstable.
 */
export function sortIssueEvents(events: ReadonlyArray<IssueEvent>): ReadonlyArray<IssueEvent> {
  return [...events].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

// ── Inline label creation ──────────────────────────────────────────────

/**
 * The colour a label typed into the sheet takes: the next one in the palette that nothing is
 * already wearing, so a tracker built label-by-label gets a spread rather than eight greys.
 */
export function nextIssueLabelColor(
  palette: ReadonlyArray<string>,
  used: ReadonlyArray<{ readonly color: string }>,
  fallback: string,
): string {
  if (palette.length === 0) return fallback;
  const taken = new Set(used.map((label) => label.color.toLowerCase()));
  return (
    palette.find((color) => !taken.has(color.toLowerCase())) ??
    palette[used.length % palette.length] ??
    fallback
  );
}

/** Null when the name is unusable or already taken, so the create button can stay disabled. */
export function issueLabelCreateName(
  raw: string,
  existing: ReadonlyArray<{ readonly name: string }>,
): string | null {
  const name = raw.trim();
  if (name.length === 0) return null;
  const clash = existing.some((label) => label.name.toLowerCase() === name.toLowerCase());
  return clash ? null : name;
}

/**
 * A milestone typed into the picker. Names clash only within their project, because that is the
 * only place two of them are ever listed side by side.
 */
export function issueMilestoneCreateName(
  raw: string,
  existing: ReadonlyArray<{ readonly name: string }>,
): string | null {
  return issueLabelCreateName(raw, existing);
}

/**
 * What is wrong with a cycle draft, said the way the dialog says it. Null means it can be created.
 * Both dates are required — a cycle *is* a range — and `YYYY-MM-DD` compares as text.
 */
export function issueCycleDraftError(draft: {
  readonly name: string;
  readonly startDate: string;
  readonly endDate: string;
}): string | null {
  if (draft.name.trim().length === 0) return "A cycle needs a name.";
  if (!isCompleteIssueDate(draft.startDate)) return "Pick a start date.";
  if (!isCompleteIssueDate(draft.endDate)) return "Pick an end date.";
  if (draft.endDate.trim() < draft.startDate.trim()) return "The cycle ends before it starts.";
  return null;
}

// ── Hierarchy ──────────────────────────────────────────────────────────

/**
 * Parent and child lookups built once per render of a picker, mirroring `IssueTree` on the server
 * (`IssueTrackerService.ts:422`). The depth rule is duplicated rather than asked for: a picker that
 * offered a parent the server refuses would fail on the press instead of at the choice.
 */
export interface IssueTreeIndex {
  readonly byId: ReadonlyMap<IssueId, Issue>;
  readonly childrenByParent: ReadonlyMap<IssueId, ReadonlyArray<Issue>>;
}

/**
 * Soft-deleted rows are **kept**. They are still rows with a `parentId`, and the server counts
 * them when it measures depth (`IssueTrackerService.ts` `buildIssueTree` reads every record,
 * deleted or not), so an index that dropped them would compute a shallower chain than the server
 * and offer a parent the write then refuses. Keeping them is only safe because the store now
 * keeps them too: a soft delete arrives as an upsert carrying `deletedAt`, not as `IssueDeleted`.
 *
 * They are excluded from *candidate* lists instead — see {@link canParentIssue}.
 */
export function buildIssueTreeIndex(issues: Iterable<Issue>): IssueTreeIndex {
  const byId = new Map<IssueId, Issue>();
  const childrenByParent = new Map<IssueId, Array<Issue>>();
  for (const issue of issues) {
    byId.set(issue.id, issue);
  }
  for (const issue of byId.values()) {
    if (issue.parentId === null) continue;
    const siblings = childrenByParent.get(issue.parentId);
    if (siblings === undefined) childrenByParent.set(issue.parentId, [issue]);
    else siblings.push(issue);
  }
  return { byId, childrenByParent };
}

/**
 * How many ancestors an issue has; a root sits at 0. The walk carries a visited set because a row
 * written before the cap existed could still hold a loop, and a hang is a worse answer than a
 * wrong number.
 */
export function issueAncestorDepth(tree: IssueTreeIndex, issueId: IssueId): number {
  const seen = new Set<IssueId>();
  let current = tree.byId.get(issueId);
  let depth = 0;
  while (current !== undefined && current.parentId !== null && !seen.has(current.id)) {
    // The edge is counted before the parent is looked up, which is what the server does. A
    // `parentId` pointing at nothing is a row this client is missing, not a root: undercounting
    // there would offer a parent the write refuses, and the whole point of this file is to agree.
    seen.add(current.id);
    depth += 1;
    current = tree.byId.get(current.parentId);
  }
  return depth;
}

/** How far the tree under an issue reaches. A leaf is 0, so a parent of leaves is 1. */
export function issueSubtreeHeight(
  tree: IssueTreeIndex,
  issueId: IssueId,
  seen: Set<IssueId> = new Set(),
): number {
  if (seen.has(issueId)) return 0;
  seen.add(issueId);
  let height = 0;
  for (const child of tree.childrenByParent.get(issueId) ?? []) {
    height = Math.max(height, 1 + issueSubtreeHeight(tree, child.id, seen));
  }
  return height;
}

/** Whether `candidateId` sits under `issueId` — the cycle a reparent would create. */
export function isIssueDescendantOf(
  tree: IssueTreeIndex,
  candidateId: IssueId,
  issueId: IssueId,
): boolean {
  const seen = new Set<IssueId>();
  let current = tree.byId.get(candidateId);
  while (current !== undefined && current.parentId !== null && !seen.has(current.id)) {
    if (current.parentId === issueId) return true;
    seen.add(current.id);
    current = tree.byId.get(current.parentId);
  }
  return false;
}

/**
 * The server's rule, verbatim (`IssueTrackerService.ts:850`): not itself, not one of its own
 * descendants, and the whole subtree still has to fit under {@link ISSUE_MAX_PARENT_DEPTH} once it
 * moves — a two-deep subtree cannot hang off a candidate that is already two deep.
 */
export function canParentIssue(
  tree: IssueTreeIndex,
  input: { readonly issueId: IssueId; readonly candidateId: IssueId },
): boolean {
  const { issueId, candidateId } = input;
  if (issueId === candidateId) return false;
  const candidate = tree.byId.get(candidateId);
  if (candidate === undefined) return false;
  // Soft-deleted rows count for depth but are never offered: the index keeps them so the walk
  // matches the server's, not so a person can file an issue under one that is in the bin.
  if (candidate.deletedAt !== null) return false;
  if (isIssueDescendantOf(tree, candidateId, issueId)) return false;
  const depth =
    issueAncestorDepth(tree, candidateId) + 1 + issueSubtreeHeight(tree, issueId, new Set());
  return depth <= ISSUE_MAX_PARENT_DEPTH;
}

// ── Issue search ───────────────────────────────────────────────────────

/** A picker is a popover on a sheet, not a page: past this it scrolls instead of being scanned. */
export const ISSUE_PICKER_MAX_RESULTS = 8;

/**
 * Key first, then title, both case-insensitive and both matched anywhere: `221` should find
 * `PAT-221`, and a key is what a person pastes. Ranked so a key hit outranks a title hit — nothing
 * else about the order is meaningful, so ties keep the order they arrived in.
 */
function issueSearchRank(issue: Issue, query: string): number {
  const key = issue.key.toLowerCase();
  if (key === query) return 0;
  if (key.startsWith(query)) return 1;
  if (key.includes(query)) return 2;
  const title = issue.title.toLowerCase();
  if (title.startsWith(query)) return 3;
  if (title.includes(query)) return 4;
  return -1;
}

/**
 * The candidate list behind every issue picker. An empty query lists the first `limit` issues
 * rather than nothing, so the picker is usable before anybody types.
 */
export function searchIssues(
  issues: Iterable<Issue>,
  input: {
    readonly query: string;
    readonly exclude?: ReadonlySet<IssueId> | undefined;
    readonly limit?: number | undefined;
  },
): ReadonlyArray<Issue> {
  const query = input.query.trim().toLowerCase();
  const limit = input.limit ?? ISSUE_PICKER_MAX_RESULTS;
  const ranked: Array<{ readonly issue: Issue; readonly rank: number }> = [];
  for (const issue of issues) {
    if (issue.deletedAt !== null) continue;
    if (input.exclude?.has(issue.id) === true) continue;
    const rank = query.length === 0 ? 0 : issueSearchRank(issue, query);
    if (rank === -1) continue;
    ranked.push({ issue, rank });
  }
  // Stable by construction: `Array.prototype.sort` keeps insertion order inside a rank.
  return ranked
    .sort((left, right) => left.rank - right.rank)
    .slice(0, limit)
    .map((entry) => entry.issue);
}

/** The parents this issue may take, already searched. */
export function issueParentCandidates(
  tree: IssueTreeIndex,
  input: {
    readonly issueId: IssueId;
    readonly query: string;
    readonly limit?: number | undefined;
  },
): ReadonlyArray<Issue> {
  const allowed: Array<Issue> = [];
  for (const candidate of tree.byId.values()) {
    if (canParentIssue(tree, { issueId: input.issueId, candidateId: candidate.id })) {
      allowed.push(candidate);
    }
  }
  return searchIssues(allowed, {
    query: input.query,
    ...(input.limit === undefined ? {} : { limit: input.limit }),
  });
}

// ── Todos ──────────────────────────────────────────────────────────────

/** The `2/5` beside a checklist. Unlike a sub-issue rollup there is nothing to cancel. */
export function issueTodoProgress(todos: ReadonlyArray<IssueTodo>): IssueProgress {
  let done = 0;
  for (const todo of todos) if (todo.done) done += 1;
  return { done, total: todos.length };
}

export function issueTodoTogglePatch(todo: IssueTodo): IssueTodoPatch {
  return { done: !todo.done };
}

/** Null on a no-op or on an empty line, which is a rejected edit rather than a delete. */
export function issueTodoTextPatch(todo: IssueTodo, raw: string): IssueTodoPatch | null {
  const text = raw.trim();
  if (text.length === 0 || text === todo.text) return null;
  return { text };
}

export function issueTodoCreateText(raw: string): string | null {
  const text = raw.trim();
  return text.length === 0 ? null : text;
}

/**
 * The complete order after a drag, or null when the drop changed nothing — the same shape
 * `reorderedIssueStatusIds` has, because the reorder RPCs take a whole list rather than a move.
 */
export function reorderedIssueTodoIds(input: {
  readonly todos: ReadonlyArray<IssueTodo>;
  readonly activeId: string;
  readonly overId: string;
}): ReadonlyArray<IssueTodoId> | null {
  const ids = input.todos.map((todo) => todo.id);
  const from = ids.findIndex((id) => id === input.activeId);
  const to = ids.findIndex((id) => id === input.overId);
  if (from === -1 || to === -1 || from === to) return null;
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return null;
  next.splice(to, 0, moved);
  return next;
}

// ── Relations ──────────────────────────────────────────────────────────

/**
 * The order the sheet stacks the groups in: what is holding this issue up comes before what it is
 * holding up. Deliberately not `issueRelationDisplays`' sort order, which is the id-stable one the
 * state layer needs; grouping is a reading decision.
 */
const ISSUE_RELATION_GROUP_ORDER: ReadonlyArray<IssueRelationLabel> = [
  "Blocked by",
  "Blocking",
  "Related",
  "Duplicate",
];

export interface IssueRelationGroup {
  readonly label: IssueRelationLabel;
  readonly displays: ReadonlyArray<IssueRelationDisplay>;
}

/** Empty groups are dropped: a section header with nothing under it is noise on a sheet. */
export function groupIssueRelationDisplays(
  displays: ReadonlyArray<IssueRelationDisplay>,
): ReadonlyArray<IssueRelationGroup> {
  const groups: Array<IssueRelationGroup> = [];
  for (const label of ISSUE_RELATION_GROUP_ORDER) {
    const matching = displays.filter((display) => display.label === label);
    if (matching.length > 0) groups.push({ label, displays: matching });
  }
  return groups;
}

/**
 * What the add-relation picker offers. "Blocked by" is not a kind — it is a `blocks` row read from
 * the other end — so choosing it swaps which issue the stored row names first.
 */
export type IssueRelationChoiceValue = "blocks" | "blocked-by" | "relates" | "duplicate";

export interface IssueRelationChoice {
  readonly value: IssueRelationChoiceValue;
  readonly label: IssueRelationLabel;
  readonly kind: IssueRelationKind;
  /** True when the issue being edited is the *related* end of the stored row. */
  readonly inverted: boolean;
}

/** Blocked-by leads because it is the one a triage pass is looking for. */
export const DEFAULT_ISSUE_RELATION_CHOICE: IssueRelationChoice = {
  value: "blocked-by",
  label: "Blocked by",
  kind: "blocks",
  inverted: true,
};

export const ISSUE_RELATION_CHOICES: ReadonlyArray<IssueRelationChoice> = [
  DEFAULT_ISSUE_RELATION_CHOICE,
  { value: "blocks", label: "Blocking", kind: "blocks", inverted: false },
  { value: "relates", label: "Related", kind: "relates", inverted: false },
  { value: "duplicate", label: "Duplicate", kind: "duplicate", inverted: false },
];

export function issueRelationChoice(value: IssueRelationChoiceValue): IssueRelationChoice {
  return (
    ISSUE_RELATION_CHOICES.find((choice) => choice.value === value) ?? DEFAULT_ISSUE_RELATION_CHOICE
  );
}

/** Null on a self-relation, which the server refuses as `invalid`. */
export function issueRelationCreateInput(input: {
  readonly issueId: IssueId;
  readonly otherIssueId: IssueId;
  readonly choice: IssueRelationChoice;
}): IssueRelationCreateInput | null {
  if (input.issueId === input.otherIssueId) return null;
  return input.choice.inverted
    ? { issueId: input.otherIssueId, relatedIssueId: input.issueId, kind: input.choice.kind }
    : { issueId: input.issueId, relatedIssueId: input.otherIssueId, kind: input.choice.kind };
}

// ── Comments ───────────────────────────────────────────────────────────

/**
 * Only the human edits or deletes a comment, which is what the server enforces too: an agent's
 * comment is part of the record, and there is one person per environment so no id is compared.
 */
export function canEditIssueComment(comment: IssueComment): boolean {
  return comment.author.kind === "user";
}

/**
 * Null when there is nothing to post. Trimmed, unlike a description: the composer submits on
 * Cmd+Enter and the newline that a Return before it left behind is not part of what was written.
 */
export function issueCommentCreateBody(raw: string): string | null {
  const body = raw.trim();
  return body.length === 0 ? null : body;
}

export function issueCommentUpdatePatch(
  comment: IssueComment,
  raw: string,
): IssueCommentPatch | null {
  const body = issueCommentCreateBody(raw);
  if (body === null || body === comment.body) return null;
  return { body };
}
