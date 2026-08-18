/**
 * Pure decisions behind the triage queue — see `docs/internals/decisions/0006-issue-tracker.md`.
 *
 * Triage is state outside the workflow: an item in it has no meaningful status, so the queue is a
 * flat list rather than the status-grouped view the rest of `/issues` is. What a row shows is
 * therefore different too — where it came from and how long it has been sitting there, rather than
 * a status dot and a board position.
 *
 * Accepting is one write that sets status, project, priority, and assignment together, so the
 * dialog's defaults are a single calculation over the selection rather than independent ones.
 * Doing it here keeps "the first unstarted status" and "the project every selected item was
 * auto-tagged with" testable without a connection.
 *
 * @module components/issues/triage.logic
 */
import type {
  Issue,
  IssueAssignee,
  IssueEnrichmentRun,
  IssueId,
  IssuePriority,
  IssueSlackSource,
  IssueStatus,
  IssueStatusId,
  IssueTriageAcceptInput,
  ProjectId,
} from "@spiritdevs/contracts";

import type { IssueInvestigateBlock } from "./issueEnrichment.logic";

// ── Age ────────────────────────────────────────────────────────────────

/**
 * How long a triage item has been waiting. Deliberately coarse and deliberately pure: the queue is
 * read at a glance, and the row must render the same string in a test as it does at 3am.
 *
 * A future timestamp reads as `now` rather than as a negative age — clock skew between a laptop
 * and the machine holding the tracker is a real thing and not worth a minus sign.
 */
export function formatIssueAge(createdAt: string, nowMs: number): string {
  const createdMs = Date.parse(createdAt);
  if (Number.isNaN(createdMs)) return "";
  const seconds = Math.floor(Math.max(0, nowMs - createdMs) / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

// ── Slack source ───────────────────────────────────────────────────────

/**
 * Slack's mrkdwn, flattened to the one line a row has for it.
 *
 * The wire carries what a person typed, which means `<@U024BE7LH>` where they typed a name and
 * `&amp;` where they typed an ampersand. Rendering that verbatim in a triage row shows an id to
 * somebody deciding whether to accept an issue, so the six escapes Slack actually defines are
 * undone here. Anything else — bold, italics, code fences — is left exactly as typed: it is
 * legible as-is, and the description keeps the original in full.
 */
export function formatSlackMrkdwn(text: string): string {
  return (
    text
      // `<!here>`, `<!channel|@channel>`: a broadcast, which reads as the word it broadcasts to.
      .replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, "@$1")
      // `<@U024BE7LH|corey>` and `<#C024BE7LH|general>` — the label after the pipe when there is one.
      .replace(/<@[^>|]+\|([^>]*)>/g, "@$1")
      .replace(/<@[^>|]+>/g, "@someone")
      .replace(/<#[^>|]+\|([^>]*)>/g, "#$1")
      .replace(/<#[^>|]+>/g, "#channel")
      // A link: the label if it was given one, otherwise the target itself.
      .replace(/<(https?:[^>|]+)\|([^>]*)>/g, "$2")
      .replace(/<(https?:[^>|]+)>/g, "$1")
      // Unescaped last: Slack escapes a typed `<` as `&lt;`, so undoing that first would hand the
      // patterns above a tag the author actually typed.
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** What the source chip on a triage row draws. */
export interface TriageSourceChip {
  /** `#design`, or the raw channel id when nothing is watching that channel any more. */
  readonly channelLabel: string;
  /** Null when Slack did not say who wrote it — a bot post, or a user lookup that failed. */
  readonly authorLabel: string | null;
  /** Null when Slack never answered with one; the chip is then text rather than a link. */
  readonly permalink: string | null;
  /** The whole chip as one string, for a `title` attribute and for a screen reader. */
  readonly label: string;
}

/**
 * The chip for one Slack-sourced issue. `channelNames` is the watch table's id→name map: the
 * source row on the issue carries only the id, because a channel can be renamed and the id is the
 * only thing the poller, the echo registry, and the reply path all agree on.
 */
export function slackSourceChip(
  source: IssueSlackSource,
  channelNames: ReadonlyMap<string, string>,
): TriageSourceChip {
  const name = channelNames.get(source.channelId);
  const channelLabel = name === undefined ? source.channelId : `#${name}`;
  const authorLabel = source.authorName;
  return {
    channelLabel,
    authorLabel,
    permalink: source.permalink,
    label: authorLabel === null ? channelLabel : `${channelLabel} · ${authorLabel}`,
  };
}

/** Historical Slack sources predate company integration identity and cannot safely sync replies. */
export function isLegacySlackSource(source: IssueSlackSource): boolean {
  return source.integrationId === undefined || source.workspaceId === undefined;
}

// ── Rows ───────────────────────────────────────────────────────────────

export interface TriageRowPresentation {
  readonly issueId: string;
  readonly issueKey: string;
  /** Flattened mrkdwn when the item came from Slack, the stored title otherwise. */
  readonly title: string;
  /** Null for an item that did not come from Slack — a manual create, or an agent's. */
  readonly source: TriageSourceChip | null;
  readonly ageLabel: string;
  /** The auto-tag the channel applied, named. Null when the channel maps to no project. */
  readonly projectTitle: string | null;
}

export function triageRowPresentation(input: {
  readonly issue: Issue;
  readonly channelNames: ReadonlyMap<string, string>;
  readonly projectTitles: ReadonlyMap<string, string>;
  readonly nowMs: number;
}): TriageRowPresentation {
  const { issue } = input;
  const source =
    issue.slackSource === null ? null : slackSourceChip(issue.slackSource, input.channelNames);
  return {
    issueId: issue.id,
    issueKey: issue.key,
    title: source === null ? issue.title : formatSlackMrkdwn(issue.title),
    source,
    ageLabel: formatIssueAge(issue.createdAt, input.nowMs),
    projectTitle:
      issue.projectId === null ? null : (input.projectTitles.get(issue.projectId) ?? null),
  };
}

// ── Accept ─────────────────────────────────────────────────────────────

/**
 * Where an accepted item lands by default: the first status in the `unstarted` category.
 *
 * The same rule a create follows, and for the same reason — accepting is what puts an issue into
 * the workflow, and the front of the workflow is where it goes unless somebody says otherwise.
 * Falls back to the first status of any category on a tracker configured without an unstarted one.
 */
export function firstUnstartedStatusId(statuses: ReadonlyArray<IssueStatus>): IssueStatusId | null {
  const unstarted = statuses.find((status) => status.category === "unstarted");
  return (unstarted ?? statuses[0])?.id ?? null;
}

/**
 * The project every selected item already carries, or null when they disagree.
 *
 * A bulk accept applies one project to the whole selection, so prefilling from the auto-tag is only
 * honest when there is one auto-tag. Two channels mapped to two projects means the dialog opens on
 * "No project" rather than silently moving half the selection.
 */
export function sharedTriageProjectId(issues: ReadonlyArray<Issue>): ProjectId | null {
  const first = issues[0];
  if (first === undefined) return null;
  return issues.every((issue) => issue.projectId === first.projectId) ? first.projectId : null;
}

/**
 * Why "Investigate after accepting" cannot be ticked, or null when it can.
 *
 * The same two refusals the enrichment panel already names, checked here so the checkbox is
 * disabled with a sentence rather than the accept coming back carrying a refusal. The server
 * checks again and reports its answer alongside the accept, which is what covers the race where a
 * project loses its directory between the dialog opening and the confirm.
 */
export function triageInvestigateBlock(input: {
  readonly projectId: ProjectId | null;
  /** Project id → `workspaceRoot`. A missing entry reads as rootless: no directory to hand over. */
  readonly workspaceRoots: ReadonlyMap<string, string | null>;
}): Extract<IssueInvestigateBlock, "no-project" | "rootless-project"> | null {
  if (input.projectId === null) return "no-project";
  const root = input.workspaceRoots.get(input.projectId);
  return root === null || root === undefined ? "rootless-project" : null;
}

export interface TriageAcceptDraft {
  readonly statusId: IssueStatusId | null;
  readonly projectId: ProjectId | null;
  readonly priority: IssuePriority;
  readonly assignee: IssueAssignee | null;
  /** Default on, and forced off when {@link triageInvestigateBlock} refuses. */
  readonly runEnrichment: boolean;
}

/**
 * Where a finished investigation used to land. The server appended it to the issue description
 * under this heading until investigations moved to an agent comment, so issues investigated before
 * that still carry the block in their description and nothing else. Read as a last resort: an
 * issue investigated since is recognised by its run row, which is the fact rather than a rendering
 * of it.
 */
const LEGACY_INVESTIGATION_BLOCK_PATTERN = /^## Investigation \(/mu;
const EMPTY_INVESTIGATED_ISSUE_IDS: ReadonlySet<IssueId> = new Set();
const EMPTY_ENRICHMENT_RUNS: ReadonlyArray<IssueEnrichmentRun> = [];

/**
 * A run that produced an investigation. `done` with a result is exactly the condition the server
 * writes the investigation comment under, so this is the same fact the comment is — and it is
 * readable without loading the thread.
 */
export function isCompletedInvestigationRun(run: IssueEnrichmentRun): boolean {
  return run.state === "done" && run.result !== null;
}

/**
 * Whether this issue has an investigation somebody could read.
 *
 * `enrichmentRuns` is what the surface has loaded — `issues.getEnrichmentRuns` answers with every
 * run the tracker has kept for the issue, which is what makes this survive a reload, unlike the
 * live set of ids the stream builds. Runs for other issues are ignored rather than trusted, so a
 * caller may pass a list it did not filter.
 */
export function issueHasCompletedInvestigation(
  issue: Issue,
  enrichmentRuns: ReadonlyArray<IssueEnrichmentRun> = EMPTY_ENRICHMENT_RUNS,
): boolean {
  return (
    enrichmentRuns.some((run) => run.issueId === issue.id && isCompletedInvestigationRun(run)) ||
    LEGACY_INVESTIGATION_BLOCK_PATTERN.test(issue.description)
  );
}

/**
 * Whether accepting would duplicate an investigation already started by Slack routing.
 *
 * Broader than {@link issueHasCompletedInvestigation}: a run still queued or running counts, since
 * a second one offered by default would race it. A failed run does not — retrying on acceptance is
 * the point of offering it.
 */
export function issueAlreadyInvestigated(
  issue: Issue,
  investigatedIssueIds: ReadonlySet<IssueId> = EMPTY_INVESTIGATED_ISSUE_IDS,
  enrichmentRuns: ReadonlyArray<IssueEnrichmentRun> = EMPTY_ENRICHMENT_RUNS,
): boolean {
  return (
    investigatedIssueIds.has(issue.id) ||
    enrichmentRuns.some((run) => run.issueId === issue.id && run.state !== "failed") ||
    issueHasCompletedInvestigation(issue, enrichmentRuns)
  );
}

/**
 * What the accept dialog opens on. Priority defaults to the one the selection already shares —
 * intake files everything at `none`, but an agent or an enrichment suggestion may have set one
 * before anybody triaged it, and reopening the dialog should not read as clearing that.
 */
export function triageAcceptDefaults(input: {
  readonly issues: ReadonlyArray<Issue>;
  readonly statuses: ReadonlyArray<IssueStatus>;
  readonly workspaceRoots: ReadonlyMap<string, string | null>;
  readonly investigatedIssueIds?: ReadonlySet<IssueId> | undefined;
  /** Runs the dialog has loaded, which is the durable half of "already investigated". */
  readonly enrichmentRuns?: ReadonlyArray<IssueEnrichmentRun> | undefined;
}): TriageAcceptDraft {
  const projectId = sharedTriageProjectId(input.issues);
  const first = input.issues[0];
  const sharedPriority =
    first !== undefined && input.issues.every((issue) => issue.priority === first.priority)
      ? first.priority
      : "none";
  const sharedAssignee =
    first !== undefined &&
    input.issues.every(
      (issue) =>
        issue.assignee?.kind === first.assignee?.kind &&
        (issue.assignee?.kind !== "agent" ||
          (first.assignee?.kind === "agent" &&
            issue.assignee.provider === first.assignee.provider)),
    )
      ? first.assignee
      : null;
  return {
    statusId: firstUnstartedStatusId(input.statuses),
    projectId,
    priority: sharedPriority,
    assignee: sharedAssignee ?? null,
    runEnrichment:
      triageInvestigateBlock({ projectId, workspaceRoots: input.workspaceRoots }) === null &&
      !input.issues.some((issue) =>
        issueAlreadyInvestigated(issue, input.investigatedIssueIds, input.enrichmentRuns),
      ),
  };
}

/**
 * The write. `projectId` always rides explicitly — the contract lets it be absent to mean "keep the
 * auto-tag", but the dialog *showed* a project, so sending what was shown is the only reading that
 * cannot surprise somebody who cleared it.
 *
 * Null when no status is selected, which the confirm button is disabled on: leaving triage means
 * landing in the workflow, and the workflow is statuses.
 */
export function triageAcceptInput(input: {
  readonly issue: Issue;
  readonly draft: TriageAcceptDraft;
  readonly investigateBlocked: boolean;
}): IssueTriageAcceptInput | null {
  const { statusId } = input.draft;
  if (statusId === null) return null;
  return {
    issueId: input.issue.id,
    statusId,
    projectId: input.draft.projectId,
    priority: input.draft.priority,
    assignee: input.draft.assignee,
    runEnrichment: input.draft.runEnrichment && !input.investigateBlocked,
  };
}

/** `Accept 3 items` / `Accept PAT-12`, which is the confirm button and the dialog's title. */
export function triageAcceptLabel(issues: ReadonlyArray<Issue>): string {
  if (issues.length === 1) return `Accept ${issues[0]?.key ?? "issue"}`;
  return `Accept ${issues.length} issues`;
}
