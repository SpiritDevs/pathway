/**
 * The `issues` MCP toolkit — handler half.
 *
 * Everything here is a translation layer between what an agent can say and what
 * {@link IssueTrackerService} takes. The service speaks ids; an agent speaks keys and names, and
 * has never seen an id. So each handler reads the snapshot once, indexes it, resolves the names in
 * the request against that index, and answers a miss with the list of valid options — a wrong
 * guess should cost one round trip, not a dead end.
 *
 * Writes carry `{ kind: "agent", provider }`, taken from the MCP credential the call arrived on.
 * That is what makes an agent's edits attributable in `issue_events`, which is the whole safety
 * story for giving agents unreviewed write access.
 *
 * @module issues/handlers
 */
import {
  type Issue,
  type IssueActor,
  type IssueAssignee,
  type IssueCreateInput,
  type IssueCycle,
  type IssueDetail,
  type IssueId,
  IssueKey,
  type IssueLabel,
  type IssueLabelId,
  type IssueMilestone,
  type IssuePatch,
  type IssueRelationDirection,
  type IssueRelationKind,
  type IssueStatus,
  type IssueStatusCategory,
  type IssueStatusId,
  type IssueThreadLinkOrigin,
  type IssueTodoId,
  type IssuesSnapshot,
  type ChatAttachmentId,
  ISSUE_COMMENT_EVIDENCE_VIDEO_MAX_BYTES,
  issueAttachmentMaxBytes,
  PREVIEW_AUTOMATION_RECORDING_CHUNK_MAX_BYTES,
  type PreviewAutomationRecordingChunk,
  type PreviewAutomationSnapshot,
  IssueTrackerError,
  ProviderDriverKind,
  ThreadId,
  isProviderDriverKind,
} from "@spiritdevs/contracts";
import { MembershipId } from "@spiritdevs/contracts/company";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  type IssueCompanyMember,
  IssueTrackerService,
  type IssueTrackerServiceShape,
} from "../../../issues/IssueTrackerService.ts";
import {
  ProjectionProjectRepository,
  type ProjectionProject,
} from "../../../persistence/Services/ProjectionProjects.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import {
  ISSUES_MCP_LIST_DEFAULT_LIMIT,
  ISSUES_MCP_LIST_MAX_LIMIT,
  IssuesToolkit,
  type IssuesMcpDetail,
  type IssuesMcpAttachment,
  type IssuesMcpMilestone,
  type IssuesMcpRow,
} from "./tools.ts";

/**
 * Colours new labels take, in the order they are minted. The same palette the CSV importer uses:
 * a label an agent invents should be indistinguishable from one an import produced.
 */
const AGENT_LABEL_COLORS: ReadonlyArray<string> = [
  "#eb5757",
  "#f2994a",
  "#f2c94c",
  "#4cb782",
  "#26b5ce",
  "#5e6ad2",
  "#bb87fc",
  "#95a2b3",
];

const ISSUE_STATUS_CATEGORIES: ReadonlyArray<IssueStatusCategory> = [
  "backlog",
  "unstarted",
  "started",
  "review",
  "completed",
  "canceled",
];

const notFound = (message: string, subject?: string) =>
  new IssueTrackerError({
    reason: "not-found",
    message,
    ...(subject === undefined || subject.length === 0 ? {} : { subject }),
  });

const invalid = (message: string, subject?: string) =>
  new IssueTrackerError({
    reason: "invalid",
    message,
    ...(subject === undefined || subject.length === 0 ? {} : { subject }),
  });

const storage = (message: string) => new IssueTrackerError({ reason: "storage", message });

/** Turns a post-create failure into an actionable retry of the already-created issue. */
export const issueCreateContinuationFailure = (retryIdentity: string, error: IssueTrackerError) =>
  new IssueTrackerError({
    reason: "conflict",
    subject: retryIdentity,
    message: `Task creation succeeded, but the remaining create workflow did not finish: ${error.message} Retry issues_create with idempotencyKey "${retryIdentity}" to resume the same task.`,
  });

const evidenceFailure = (cause: { readonly message: string }) =>
  new IssueTrackerError({
    reason: "storage",
    message: `Failed to capture browser evidence: ${cause.message}`,
  });

/** `"Backlog", "Todo", "Done"` — the tail of every "no such thing" message. */
export const quoteOptions = (values: Iterable<string>): string => {
  const items = [...values];
  return items.length === 0 ? "none are configured" : items.map((value) => `"${value}"`).join(", ");
};

/** Agents type `pat-12` about as often as `PAT-12`, and both name the same issue. */
export const normalizeIssueKey = (raw: string): string => raw.trim().toUpperCase();

const normalizeName = (raw: string): string => raw.trim().toLowerCase();

/**
 * How an actor reads in a tool result: `user`, `member:<id> (Ada Lovelace)`, `agent:codex`,
 * `system:import`. The name rides along so a person can be recognised; the id is what stays exact.
 */
export const formatIssueActor = (
  actor: IssueActor | null,
  members?: Pick<TrackerIndex, "memberById">,
): string | null => {
  if (actor === null) return null;
  switch (actor.kind) {
    case "user":
      return "user";
    case "member": {
      const name = members?.memberById.get(actor.membershipId)?.displayName;
      return name ? `member:${actor.membershipId} (${name})` : `member:${actor.membershipId}`;
    }
    case "agent":
      return `agent:${actor.provider}`;
    case "system":
      return `system:${actor.source}`;
  }
};

/**
 * The stored relation row read from one issue's side. `blocks` inbound is "blocked by"; there is
 * no second row saying so, which is why the phrase has to be computed rather than looked up.
 */
export const issueRelationPhrase = (
  kind: IssueRelationKind,
  direction: IssueRelationDirection,
): string => {
  if (kind === "blocks") return direction === "outgoing" ? "blocks" : "blocked by";
  if (kind === "duplicate") return direction === "outgoing" ? "duplicates" : "duplicated by";
  return "relates to";
};

/**
 * Parse the assignee grammar the tools document. Returns `null` for "nobody" and `undefined` when
 * the token means nothing here — the caller turns that into a message naming the valid forms,
 * which is more useful than a schema rejection listing a union.
 */
export const parseIssueAssignee = (
  raw: string,
  self: ProviderDriverKind,
): IssueAssignee | null | undefined => {
  const token = raw.trim();
  if (token.length === 0) return undefined;
  const lowered = token.toLowerCase();
  if (lowered === "none" || lowered === "unassigned" || lowered === "nobody") return null;
  if (lowered === "user" || lowered === "me" || lowered === "human") return { kind: "user" };
  if (lowered === "agent" || lowered === "self" || lowered === "you") {
    return { kind: "agent", provider: self };
  }
  if (lowered.startsWith("member:")) {
    // Results print `member:<id> (Name)`; reading one back takes just the id.
    const membershipId = token.slice("member:".length).trim().split(/\s/)[0] ?? "";
    return membershipId.length === 0
      ? undefined
      : { kind: "member", membershipId: MembershipId.make(membershipId) };
  }
  const slug = lowered.startsWith("agent:") ? token.slice("agent:".length).trim() : token;
  if (!isProviderDriverKind(slug)) return undefined;
  return { kind: "agent", provider: slug };
};

/**
 * The snapshot, turned into the lookups every handler needs. Read once per tool call: the tracker
 * is a few thousand rows and a second read mid-call could disagree with the first.
 */
interface TrackerIndex {
  readonly snapshot: IssuesSnapshot;
  readonly issuesByKey: ReadonlyMap<string, Issue>;
  readonly issuesById: ReadonlyMap<IssueId, Issue>;
  readonly childrenByParent: ReadonlyMap<IssueId, ReadonlyArray<Issue>>;
  readonly statusById: ReadonlyMap<IssueStatusId, IssueStatus>;
  /** Ascending, which is what "the first status in the completed category" means. */
  readonly statuses: ReadonlyArray<IssueStatus>;
  readonly labelById: ReadonlyMap<IssueLabelId, IssueLabel>;
  readonly milestones: ReadonlyArray<IssueMilestone>;
  readonly cycles: ReadonlyArray<IssueCycle>;
  readonly projects: ReadonlyArray<ProjectionProject>;
  readonly projectById: ReadonlyMap<string, ProjectionProject>;
  readonly memberById: ReadonlyMap<string, IssueCompanyMember>;
}

const buildIndex = (
  snapshot: IssuesSnapshot,
  projects: ReadonlyArray<ProjectionProject>,
  members: ReadonlyArray<IssueCompanyMember> = [],
): TrackerIndex => {
  const issuesByKey = new Map<string, Issue>();
  const issuesById = new Map<IssueId, Issue>();
  const childrenByParent = new Map<IssueId, Array<Issue>>();
  for (const issue of snapshot.issues) {
    issuesByKey.set(normalizeIssueKey(issue.key), issue);
    issuesById.set(issue.id, issue);
    if (issue.parentId !== null) {
      const siblings = childrenByParent.get(issue.parentId);
      if (siblings) siblings.push(issue);
      else childrenByParent.set(issue.parentId, [issue]);
    }
  }
  return {
    snapshot,
    issuesByKey,
    issuesById,
    childrenByParent,
    statusById: new Map(snapshot.statuses.map((status) => [status.id, status])),
    statuses: [...snapshot.statuses].sort(
      (left, right) => left.position - right.position || left.id.localeCompare(right.id),
    ),
    labelById: new Map(snapshot.labels.map((label) => [label.id, label])),
    milestones: snapshot.milestones,
    cycles: snapshot.cycles,
    projects: projects.filter((project) => project.deletedAt === null),
    projectById: new Map(projects.map((project) => [project.projectId, project])),
    memberById: new Map(members.map((member) => [member.membershipId, member])),
  };
};

const readIndex = Effect.fn("issues_mcp.readIndex")(function* () {
  const tracker = yield* IssueTrackerService;
  const projectRepository = yield* ProjectionProjectRepository;
  const snapshot = yield* tracker.getSnapshot();
  const projects = yield* projectRepository
    .listAll()
    .pipe(Effect.mapError(() => storage("Failed to read the project list.")));
  const members = yield* tracker.companyMembers;
  return buildIndex(snapshot, projects, members);
});

/** The agent behind this MCP credential, as the tracker records it. */
const callerActor = Effect.fn("issues_mcp.actor")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  return { kind: "agent", provider: invocation.providerDriverKind } as const satisfies IssueActor;
});

const withinPinnedRoute = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.flatMap(IssueTrackerService, (tracker) => tracker.withPinnedRoute(effect));

const resolveIssue = (
  index: TrackerIndex,
  key: string,
): Effect.Effect<Issue, IssueTrackerError> => {
  const normalized = normalizeIssueKey(key);
  const issue = index.issuesByKey.get(normalized);
  return issue
    ? Effect.succeed(issue)
    : Effect.fail(
        notFound(
          `No task with key "${normalized}". Use issues_list to find the key you meant.`,
          normalized,
        ),
      );
};

/**
 * A status name, or a category standing in for one. The category form is the one that matters:
 * "completed" is a fact about the workflow, while the name of the done column is a local decision
 * an agent cannot know.
 */
export const matchingStatuses = (
  statuses: ReadonlyArray<IssueStatus>,
  value: string,
): ReadonlyArray<IssueStatus> => {
  const wanted = normalizeName(value);
  const byCategory = statuses.filter((status) => status.category === wanted);
  if (ISSUE_STATUS_CATEGORIES.includes(wanted as IssueStatusCategory) && byCategory.length > 0) {
    return byCategory;
  }
  const byName = statuses.filter((status) => normalizeName(status.name) === wanted);
  return byName.length > 0 ? byName : byCategory;
};

const resolveStatuses = (
  index: TrackerIndex,
  value: string,
  statuses: ReadonlyArray<IssueStatus> = index.statuses,
): Effect.Effect<ReadonlyArray<IssueStatus>, IssueTrackerError> => {
  const matches = matchingStatuses(statuses, value);
  if (matches.length > 0) return Effect.succeed(matches);
  return Effect.fail(
    notFound(
      `No task status called "${value.trim()}". Valid statuses: ${quoteOptions(
        statuses.map((status) => status.name),
      )}. Valid categories: ${quoteOptions(ISSUE_STATUS_CATEGORIES)}.`,
      value.trim(),
    ),
  );
};

const resolveStatus = (
  index: TrackerIndex,
  value: string,
  statuses: ReadonlyArray<IssueStatus> = index.statuses,
): Effect.Effect<IssueStatus, IssueTrackerError> =>
  resolveStatuses(index, value, statuses).pipe(Effect.map((matches) => matches[0]!));

const resolveProject = (
  index: TrackerIndex,
  value: string,
): Effect.Effect<ProjectionProject, IssueTrackerError> => {
  const wanted = normalizeName(value);
  const project = index.projects.find((candidate) => normalizeName(candidate.title) === wanted);
  return project
    ? Effect.succeed(project)
    : Effect.fail(
        notFound(
          `No project called "${value.trim()}". Valid projects: ${quoteOptions(
            index.projects.map((candidate) => candidate.title),
          )}. Projects are created in Pathway, not through this toolkit.`,
          value.trim(),
        ),
      );
};

const resolveMilestone = (
  index: TrackerIndex,
  value: string,
  projectId?: IssueMilestone["projectId"],
): Effect.Effect<IssueMilestone, IssueTrackerError> => {
  const wanted = normalizeName(value);
  const inScope =
    projectId === undefined
      ? index.milestones
      : index.milestones.filter((candidate) => candidate.projectId === projectId);
  const matches = inScope.filter((candidate) => normalizeName(candidate.name) === wanted);
  if (matches.length === 1) return Effect.succeed(matches[0]!);
  if (matches.length > 1) {
    return Effect.fail(
      invalid(
        `More than one project has a milestone called "${value.trim()}". Name the project too.`,
        value.trim(),
      ),
    );
  }
  return Effect.fail(
    notFound(
      `No milestone called "${value.trim()}"${projectId === undefined ? "" : " in that project"}. Valid milestones: ${quoteOptions(
        inScope.map((candidate) => candidate.name),
      )}.`,
      value.trim(),
    ),
  );
};

const resolveCycle = (
  index: TrackerIndex,
  value: string,
  cycles: ReadonlyArray<IssueCycle> = index.cycles,
): Effect.Effect<IssueCycle, IssueTrackerError> => {
  const wanted = normalizeName(value);
  const cycle = cycles.find((candidate) => normalizeName(candidate.name) === wanted);
  return cycle
    ? Effect.succeed(cycle)
    : Effect.fail(
        notFound(
          `No cycle called "${value.trim()}". Valid cycles: ${quoteOptions(
            cycles.map((candidate) => candidate.name),
          )}.`,
          value.trim(),
        ),
      );
};

/** How a member reads in a hint: enough to pick the right person and copy their assignee. */
const describeMember = (member: IssueCompanyMember): string =>
  `${member.displayName} <${member.email}> → "member:${member.membershipId}"`;

const activeMembersHint = (members: ReadonlyArray<IssueCompanyMember>): string => {
  const active = members.filter((member) => member.active);
  return active.length === 0
    ? "This company has no active members to choose from."
    : `Active members: ${active.map(describeMember).join("; ")}.`;
};

/**
 * A person's name or email, matched case-insensitively against active members. People say
 * "assign it to Corey", never a membership id, so a unique first name is enough.
 */
const matchMembersByName = (
  members: ReadonlyArray<IssueCompanyMember>,
  raw: string,
): ReadonlyArray<IssueCompanyMember> => {
  const wanted = normalizeName(raw);
  const active = members.filter((member) => member.active);
  const exact = active.filter(
    (member) =>
      normalizeName(member.displayName) === wanted || normalizeName(member.email) === wanted,
  );
  if (exact.length > 0) return exact;
  return active.filter((member) => normalizeName(member.displayName).split(/\s+/).includes(wanted));
};

export const resolveIssueAssignee = (
  tracker: Pick<
    IssueTrackerServiceShape,
    "replicaRoutable" | "linkedMemberActor" | "activeMemberActor" | "companyMembers"
  >,
  value: string,
  self: ProviderDriverKind,
): Effect.Effect<IssueAssignee | null, IssueTrackerError> =>
  Effect.gen(function* () {
    const parsed = parseIssueAssignee(value, self);
    // Any slug parses as a provider, so a bare word like "corey" is a person first when it names
    // one; `agent:<driver>` and the keywords stay unambiguous.
    const bareWord =
      parsed === undefined ||
      (parsed?.kind === "agent" && !/^(agent|self|you)(:|$)/i.test(value.trim()));
    const members =
      bareWord && (yield* tracker.replicaRoutable) ? yield* tracker.companyMembers : [];
    const matches = bareWord ? matchMembersByName(members, value) : [];
    const [only] = matches;
    if (matches.length === 1 && only !== undefined) {
      return { kind: "member", membershipId: MembershipId.make(only.membershipId) };
    }
    if (matches.length > 1) {
      return yield* invalid(
        `"${value.trim()}" matches more than one member: ${matches.map(describeMember).join("; ")}. Pass the full name, the email, or the member:<id>.`,
        value.trim(),
      );
    }
    if (parsed === undefined) {
      return yield* invalid(
        `Cannot read "${value.trim()}" as an assignee. Use a member's name or email, "user" for the bound company member, "member:<membership-id>", "agent" for yourself, "agent:<driver>" for another provider such as "agent:codex", or "none" to leave it unassigned.${members.length === 0 ? "" : ` ${activeMembersHint(members)}`}`,
        value.trim(),
      );
    }
    if (parsed?.kind !== "user" && parsed?.kind !== "member") return parsed;
    if (!(yield* tracker.replicaRoutable)) return parsed;
    if (parsed.kind === "member") {
      const active = yield* tracker.activeMemberActor(parsed.membershipId);
      if (active !== null) return active;
      return yield* invalid(
        `No active company member has membership id "${parsed.membershipId}". ${activeMembersHint(yield* tracker.companyMembers)}`,
        value.trim(),
      );
    }
    const member = yield* tracker.linkedMemberActor;
    if (member !== null) return member;
    return yield* invalid(
      `This environment has no active bound company membership, so "${value.trim()}" names nobody. Pass a member's name or email instead. ${activeMembersHint(yield* tracker.companyMembers)}`,
      value.trim(),
    );
  });

/**
 * Names to label ids, minting the ones that do not exist yet. Labels are flat and
 * create-on-the-fly by design, so an agent inventing "flaky-test" is the intended path rather
 * than an error to route around.
 */
const resolveLabelIds = Effect.fn("issues_mcp.resolveLabels")(function* (
  tracker: IssueTrackerServiceShape,
  known: ReadonlyArray<IssueLabel>,
  names: ReadonlyArray<string>,
) {
  let working = [...known];
  const ids: Array<IssueLabelId> = [];
  for (const raw of names) {
    const name = raw.trim();
    if (name.length === 0) continue;
    const wanted = name.toLowerCase();
    const existing = working.find((label) => label.name.toLowerCase() === wanted);
    if (existing) {
      if (!ids.includes(existing.id)) ids.push(existing.id);
      continue;
    }
    const created = yield* tracker.createLabel({
      name,
      color: AGENT_LABEL_COLORS[working.length % AGENT_LABEL_COLORS.length]!,
    });
    working = [...created.labels];
    ids.push(created.label.id);
  }
  return ids;
});

/** Names of the labels already on an issue, in the tracker's own order. */
const labelNamesOf = (index: TrackerIndex, issue: Issue): ReadonlyArray<string> =>
  issue.labelIds.flatMap((id) => {
    const label = index.labelById.get(id);
    return label ? [label.name] : [];
  });

const formatIssueAttachments = (
  comments: IssueDetail["comments"],
  members?: Pick<TrackerIndex, "memberById">,
): ReadonlyArray<IssuesMcpAttachment> => {
  const seen = new Set<string>();
  const attachments: Array<IssuesMcpAttachment> = [];
  for (const [commentIndex, comment] of comments.entries()) {
    for (const attachmentId of comment.attachmentIds) {
      if (seen.has(attachmentId)) continue;
      seen.add(attachmentId);
      attachments.push({
        attachmentId,
        commentNumber: commentIndex + 1,
        author: formatIssueActor(comment.author, members) ?? "unknown",
        commentBody: comment.body,
        commentCreatedAt: comment.createdAt,
      });
    }
  }
  return attachments;
};

const formatMcpComment = (
  comment: IssueDetail["comments"][number],
  members?: Pick<TrackerIndex, "memberById">,
) => ({
  author: formatIssueActor(comment.author, members) ?? "unknown",
  body: comment.body,
  attachmentIds: comment.attachmentIds,
  createdAt: comment.createdAt,
  editedAt: comment.editedAt,
});

const formatMilestone = (index: TrackerIndex, milestone: IssueMilestone): IssuesMcpMilestone => ({
  name: milestone.name,
  project: index.projectById.get(milestone.projectId)?.title ?? "unknown",
  description: milestone.description,
  startDate: milestone.startDate,
  targetDate: milestone.targetDate,
});

export const formatIssueRow = (index: TrackerIndex, issue: Issue): IssuesMcpRow => {
  const status = index.statusById.get(issue.statusId);
  const parent = issue.parentId === null ? undefined : index.issuesById.get(issue.parentId);
  const project = issue.projectId === null ? undefined : index.projectById.get(issue.projectId);
  return {
    key: issue.key,
    title: issue.title,
    status: status?.name ?? "unknown",
    statusCategory: status?.category ?? "backlog",
    priority: issue.priority,
    assignee: formatIssueActor(issue.assignee, index),
    project: project?.title ?? null,
    parentKey: parent?.key ?? null,
    dueDate: issue.dueDate,
    triage: issue.triage,
    deletedAt: issue.deletedAt,
  };
};

const formatRelations = (index: TrackerIndex, relations: IssueDetail["relations"]) =>
  relations.flatMap((edge) => {
    const otherId =
      edge.direction === "outgoing" ? edge.relation.relatedIssueId : edge.relation.issueId;
    const other = index.issuesById.get(otherId);
    return other
      ? [
          {
            relation: issueRelationPhrase(edge.relation.kind, edge.direction),
            kind: edge.relation.kind,
            direction: edge.direction,
            key: other.key,
            title: other.title,
          },
        ]
      : [];
  });

const formatIssueDetail = (
  index: TrackerIndex,
  issue: Issue,
  detail: IssueDetail,
  threads: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly origin: IssueThreadLinkOrigin;
    readonly createdAt: string;
  }>,
): IssuesMcpDetail => {
  const row = formatIssueRow(index, issue);
  const milestone =
    issue.milestoneId === null
      ? null
      : (index.milestones.find((candidate) => candidate.id === issue.milestoneId)?.name ?? null);
  const cycle =
    issue.cycleId === null
      ? null
      : (index.cycles.find((candidate) => candidate.id === issue.cycleId)?.name ?? null);
  return {
    ...row,
    description: issue.description,
    milestone,
    cycle,
    labels: labelNamesOf(index, issue),
    subIssueKeys: (index.childrenByParent.get(issue.id) ?? [])
      .filter((child) => child.deletedAt === null)
      .map((child) => child.key),
    todos: detail.todos.map((todo) => ({ text: todo.text, done: todo.done })),
    relations: formatRelations(index, detail.relations),
    comments: detail.comments.map((comment) => formatMcpComment(comment, index)),
    attachments: formatIssueAttachments(detail.comments, index),
    threads: threads.map((link) => ({
      threadId: link.threadId,
      origin: link.origin,
      createdAt: link.createdAt,
    })),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
};

const formatCycle = (cycle: IssueCycle) => ({
  name: cycle.name,
  startDate: cycle.startDate,
  endDate: cycle.endDate,
  completed: cycle.completedAt !== null,
});

const formatLabel = (label: IssueLabel) => ({ name: label.name, color: label.color });

const formatStatus = (status: IssueStatus) => ({
  name: status.name,
  category: status.category,
  color: status.color,
});

const byPosition = (left: IssueStatus, right: IssueStatus) =>
  left.position - right.position || left.id.localeCompare(right.id);

/**
 * One row by exact name, for the tools that administer the row itself. Unlike assigning a task,
 * renaming or deleting "the done column" must not quietly pick one of several.
 */
const resolveNamed = <A extends { readonly name: string }>(
  rows: ReadonlyArray<A>,
  value: string,
  noun: string,
): Effect.Effect<A, IssueTrackerError> => {
  const wanted = normalizeName(value);
  const matches = rows.filter((row) => normalizeName(row.name) === wanted);
  if (matches.length === 1) return Effect.succeed(matches[0]!);
  return Effect.fail(
    matches.length > 1
      ? invalid(`More than one ${noun} is called "${value.trim()}"; rename one in Pathway first.`)
      : notFound(
          `No ${noun} called "${value.trim()}". Valid ${noun}s: ${quoteOptions(rows.map((row) => row.name))}.`,
          value.trim(),
        ),
  );
};

/** Names to ids for a reorder, which the tracker only accepts as a complete list. */
const orderByNames = <A extends { readonly name: string; readonly id: string }>(
  rows: ReadonlyArray<A>,
  names: ReadonlyArray<string>,
  noun: string,
): Effect.Effect<ReadonlyArray<A["id"]>, IssueTrackerError> =>
  Effect.gen(function* () {
    const ordered: Array<A["id"]> = [];
    for (const name of names) ordered.push((yield* resolveNamed(rows, name, noun)).id);
    const missing = rows.filter((row) => !ordered.includes(row.id));
    if (missing.length > 0 || new Set(ordered).size !== ordered.length) {
      return yield* invalid(
        `List every ${noun} exactly once. Current ${noun}s: ${quoteOptions(rows.map((row) => row.name))}.`,
      );
    }
    return ordered;
  });

/** 1-based positions, as issues_get numbers comments and todos, to the row. */
const numbered = <A>(
  rows: ReadonlyArray<A>,
  position: number,
  noun: string,
  key: string,
): Effect.Effect<A, IssueTrackerError> => {
  const row = rows[position - 1];
  return row === undefined
    ? Effect.fail(notFound(`${key} has ${rows.length} ${noun}s; there is no number ${position}.`))
    : Effect.succeed(row);
};

/** The stored row a phrase describes, read as "<issue> <relation> <other>". */
const relationEnds = (relation: string, issue: Issue, other: Issue) => {
  switch (relation) {
    case "blocks":
      return { issueId: issue.id, relatedIssueId: other.id, kind: "blocks" } as const;
    case "blocked by":
      return { issueId: other.id, relatedIssueId: issue.id, kind: "blocks" } as const;
    case "duplicates":
      return { issueId: issue.id, relatedIssueId: other.id, kind: "duplicate" } as const;
    case "duplicated by":
      return { issueId: other.id, relatedIssueId: issue.id, kind: "duplicate" } as const;
    default:
      return { issueId: issue.id, relatedIssueId: other.id, kind: "relates" } as const;
  }
};

/** File types tasks accept, by extension; the tracker enforces the per-type size limits. */
const ATTACHMENT_MIME_BY_EXTENSION: Record<string, string> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".json": "application/json",
  ".log": "text/plain",
  ".md": "text/plain",
  ".txt": "text/plain",
};

/** Reads each file an agent named and stores it on the task, before the comment is written. */
const storeFiles = Effect.fn("issues_mcp.storeFiles")(function* (
  issue: Issue,
  paths: ReadonlyArray<string>,
) {
  const tracker = yield* IssueTrackerService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const attachmentIds: Array<ChatAttachmentId> = [];
  for (const raw of paths) {
    const filePath = raw.trim();
    if (!path.isAbsolute(filePath)) {
      return yield* invalid(`Attach files by absolute path, not "${filePath}".`, issue.key);
    }
    const mimeType = ATTACHMENT_MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()];
    if (mimeType === undefined) {
      return yield* invalid(
        `Tasks accept images, mp4 or webm recordings, and .txt, .log, .md or .json files, not ${path.basename(filePath)}.`,
        issue.key,
      );
    }
    const info = yield* fileSystem
      .stat(filePath)
      .pipe(Effect.mapError(() => notFound(`No file at ${filePath}.`, filePath)));
    const limit = issueAttachmentMaxBytes(mimeType) ?? 0;
    if (info.type !== "File" || Number(info.size) > limit) {
      return yield* invalid(`${filePath} is not a file of at most ${limit} bytes.`, issue.key);
    }
    const bytes = yield* fileSystem
      .readFile(filePath)
      .pipe(Effect.mapError((cause) => storage(`Failed to read ${filePath}: ${cause.message}`)));
    const stored = yield* tracker.storeCommentFile({
      issueId: issue.id,
      fileName: path.basename(filePath),
      mimeType,
      bytes,
    });
    attachmentIds.push(stored.attachmentId);
  }
  return attachmentIds;
});

/** Newest-updated first. An agent asking "what is going on" means recency, not board position. */
const byRecency = (left: Issue, right: Issue): number =>
  right.updatedAt.localeCompare(left.updatedAt) || left.key.localeCompare(right.key);

const handlers = {
  issues_list: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const index = yield* readIndex();
      const project =
        input.project === undefined ? null : yield* resolveProject(index, input.project);
      const statuses =
        input.status === undefined
          ? null
          : yield* resolveStatuses(
              index,
              input.status,
              project === null
                ? index.statuses
                : yield* tracker.statusesForProject({ projectId: project.projectId }),
            );
      const statusIds = statuses === null ? null : new Set(statuses.map((status) => status.id));
      const assignee =
        input.assignee === undefined
          ? undefined
          : yield* resolveIssueAssignee(tracker, input.assignee, invocation.providerDriverKind);
      let labelIds: ReadonlySet<IssueLabelId> | null = null;
      if (input.label !== undefined) {
        const wanted = normalizeName(input.label);
        const candidates =
          project === null
            ? index.snapshot.labels
            : (yield* tracker.scopedCatalogForProject({ projectId: project.projectId })).labels;
        const labels = candidates.filter((candidate) => normalizeName(candidate.name) === wanted);
        if (labels.length === 0) {
          return yield* notFound(
            `No label called "${input.label.trim()}". Valid labels: ${quoteOptions(
              candidates.map((candidate) => candidate.name),
            )}.`,
            input.label.trim(),
          );
        }
        labelIds = new Set(labels.map((label) => label.id));
      }
      const query = input.query === undefined ? null : normalizeName(input.query);
      const includeDeleted = input.includeDeleted ?? false;

      const matched = index.snapshot.issues
        .filter((issue) => {
          if (!includeDeleted && issue.deletedAt !== null) return false;
          if (input.triage !== undefined && issue.triage !== input.triage) return false;
          if (statusIds !== null && !statusIds.has(issue.statusId)) return false;
          if (input.statusCategory !== undefined) {
            const category = index.statusById.get(issue.statusId)?.category;
            if (category !== input.statusCategory) return false;
          }
          if (project !== null && issue.projectId !== project.projectId) return false;
          if (labelIds !== null && !issue.labelIds.some((labelId) => labelIds.has(labelId)))
            return false;
          if (input.priority !== undefined && issue.priority !== input.priority) return false;
          if (assignee !== undefined) {
            if (assignee === null) {
              if (issue.assignee !== null) return false;
            } else if (
              issue.assignee === null ||
              issue.assignee.kind !== assignee.kind ||
              (assignee.kind === "agent" &&
                issue.assignee.kind === "agent" &&
                issue.assignee.provider !== assignee.provider) ||
              (assignee.kind === "member" &&
                issue.assignee.kind === "member" &&
                issue.assignee.membershipId !== assignee.membershipId)
            ) {
              return false;
            }
          }
          if (
            query !== null &&
            !issue.key.toLowerCase().includes(query) &&
            !issue.title.toLowerCase().includes(query)
          ) {
            return false;
          }
          return true;
        })
        .sort(byRecency);

      const limit = Math.min(
        Math.max(input.limit ?? ISSUES_MCP_LIST_DEFAULT_LIMIT, 1),
        ISSUES_MCP_LIST_MAX_LIMIT,
      );
      const page = matched.slice(0, limit);
      return {
        issues: page.map((issue) => formatIssueRow(index, issue)),
        matched: matched.length,
        returned: page.length,
        truncated: matched.length > page.length,
      };
    }).pipe(withinPinnedRoute),

  issues_get: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const index = yield* readIndex();
      const issue = yield* resolveIssue(index, input.key);
      const detail = yield* tracker.getDetail({ issueId: issue.id });
      const links = yield* tracker.getThreadLinks({ issueId: issue.id });
      return formatIssueDetail(index, issue, detail, links.links);
    }).pipe(withinPinnedRoute),

  issues_get_attachment: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const index = yield* readIndex();
      const issue = yield* resolveIssue(index, input.key);
      const detail = yield* tracker.getDetail({ issueId: issue.id });
      const attachmentId = input.attachmentId.trim();
      const attachment = formatIssueAttachments(detail.comments, index).find(
        (candidate) => candidate.attachmentId === attachmentId,
      );
      if (attachment === undefined) {
        return yield* notFound(
          `No attachment ${attachmentId || "(empty)"} belongs to ${issue.key}.`,
          attachmentId,
        );
      }
      return { key: issue.key, attachment };
    }).pipe(withinPinnedRoute),

  issues_milestones_list: (input) =>
    Effect.gen(function* () {
      const index = yield* readIndex();
      const project =
        input.project === undefined ? null : yield* resolveProject(index, input.project);
      return {
        milestones: index.milestones
          .filter((milestone) => project === null || milestone.projectId === project.projectId)
          .map((milestone) => formatMilestone(index, milestone)),
      };
    }).pipe(withinPinnedRoute),

  issues_milestone_create: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const index = yield* readIndex();
      const project = yield* resolveProject(index, input.project);
      const created = yield* tracker.milestoneCreate({
        projectId: project.projectId,
        name: input.name,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(input.startDate === undefined ? {} : { startDate: input.startDate }),
        ...(input.targetDate === undefined ? {} : { targetDate: input.targetDate }),
      });
      return { milestone: formatMilestone(index, created.milestone) };
    }).pipe(withinPinnedRoute),

  issues_milestone_update: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const actor = yield* callerActor();
      const index = yield* readIndex();
      const project = yield* resolveProject(index, input.project);
      const milestone = yield* resolveMilestone(index, input.milestone, project.projectId);
      const newProject =
        input.newProject === undefined ? null : yield* resolveProject(index, input.newProject);
      const updated = yield* tracker.milestoneUpdate(
        {
          milestoneId: milestone.id,
          patch: {
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.startDate === undefined ? {} : { startDate: input.startDate }),
            ...(input.targetDate === undefined ? {} : { targetDate: input.targetDate }),
            ...(newProject === null ? {} : { projectId: newProject.projectId }),
          },
        },
        actor,
      );
      const after = yield* readIndex();
      return { milestone: formatMilestone(after, updated.milestone) };
    }).pipe(withinPinnedRoute),

  issues_milestone_delete: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const actor = yield* callerActor();
      const index = yield* readIndex();
      const project = yield* resolveProject(index, input.project);
      const milestone = yield* resolveMilestone(index, input.milestone, project.projectId);
      const deleted = formatMilestone(index, milestone);
      const clearedIssues = index.snapshot.issues.filter(
        (issue) => issue.milestoneId === milestone.id,
      ).length;
      yield* tracker.milestoneDelete({ milestoneId: milestone.id }, actor);
      return { deleted, clearedIssues };
    }).pipe(withinPinnedRoute),

  issues_create: (input, context) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const actor = yield* callerActor();
      const index = yield* readIndex();

      let project =
        input.project === undefined ? null : yield* resolveProject(index, input.project);
      let milestone: IssueMilestone | null = null;
      if (input.milestone !== undefined) {
        if (project === null) {
          const wanted = normalizeName(input.milestone);
          if (!index.milestones.some((candidate) => normalizeName(candidate.name) === wanted)) {
            return yield* invalid(
              `No milestone called "${input.milestone.trim()}". Pass project to create it while filing the task.`,
              input.milestone.trim(),
            );
          }
          milestone = yield* resolveMilestone(index, input.milestone);
          project = index.projectById.get(milestone.projectId) ?? null;
          if (project === null || project.deletedAt !== null) {
            return yield* invalid(
              `Milestone "${milestone.name}" does not belong to an active project.`,
              milestone.name,
            );
          }
        } else {
          const wanted = normalizeName(input.milestone);
          const projectId = project.projectId;
          milestone =
            index.milestones.find(
              (candidate) =>
                candidate.projectId === projectId && normalizeName(candidate.name) === wanted,
            ) ?? null;
          if (milestone === null) {
            milestone = (yield* tracker.milestoneCreate({
              projectId,
              name: input.milestone,
            })).milestone;
          }
        }
      }
      const status =
        input.status === undefined
          ? null
          : yield* resolveStatus(
              index,
              input.status,
              yield* tracker.statusesForProject({ projectId: project?.projectId ?? null }),
            );
      const scopedCatalog = yield* tracker.scopedCatalogForProject({
        projectId: project?.projectId ?? null,
      });
      const cycle =
        input.cycle === undefined
          ? null
          : yield* resolveCycle(index, input.cycle, scopedCatalog.cycles);
      const parent =
        input.parentKey === undefined ? null : yield* resolveIssue(index, input.parentKey);
      const assignee =
        input.assignee === undefined
          ? undefined
          : yield* resolveIssueAssignee(tracker, input.assignee, actor.provider);
      const labelIds =
        input.labels === undefined
          ? undefined
          : yield* resolveLabelIds(tracker, scopedCatalog.labels, input.labels);

      const create: IssueCreateInput = {
        title: input.title,
        ...(input.description === undefined ? {} : { description: input.description }),
        ...(status === null ? {} : { statusId: status.id }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(project === null ? {} : { projectId: project.projectId }),
        ...(milestone === null ? {} : { milestoneId: milestone.id }),
        ...(cycle === null ? {} : { cycleId: cycle.id }),
        ...(parent === null ? {} : { parentId: parent.id }),
        ...(labelIds === undefined ? {} : { labelIds }),
        ...(input.dueDate === undefined ? {} : { dueDate: input.dueDate }),
        ...(input.triage === undefined ? {} : { triage: input.triage }),
      };
      const retryIdentity =
        input.idempotencyKey ?? invocation.requestIdempotencyKey ?? context.toolCallId;
      const created = yield* tracker.create(create, actor, retryIdentity);
      const afterCreateFailure = (error: IssueTrackerError) =>
        retryIdentity === undefined ? error : issueCreateContinuationFailure(retryIdentity, error);
      // `create` takes no assignee: assignment is a field change, and the change log should say so
      // rather than hiding an owner inside a "created" row.
      const issue =
        assignee === undefined
          ? created.issue
          : (yield* tracker
              .update({ issueId: created.issue.id, patch: { assignee } }, actor)
              .pipe(Effect.mapError(afterCreateFailure))).issue;
      const after = yield* readIndex().pipe(Effect.mapError(afterCreateFailure));
      return { issue: formatIssueRow(after, issue) };
    }).pipe(withinPinnedRoute),

  issues_update: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const actor = yield* callerActor();
      const index = yield* readIndex();
      const issue = yield* resolveIssue(index, input.key);
      const scopedCatalog = yield* tracker.scopedCatalogForIssue({ issueId: issue.id });

      const patch: {
        -readonly [K in keyof IssuePatch]: IssuePatch[K];
      } = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.description !== undefined) patch.description = input.description;
      if (input.status !== undefined) {
        const statuses = yield* tracker.statusesForIssue({ issueId: issue.id });
        patch.statusId = (yield* resolveStatus(index, input.status, statuses)).id;
      }
      if (input.priority !== undefined) patch.priority = input.priority;
      if (input.assignee !== undefined) {
        patch.assignee =
          input.assignee === null
            ? null
            : yield* resolveIssueAssignee(tracker, input.assignee, actor.provider);
      }
      if (input.project !== undefined) {
        patch.projectId =
          input.project === null ? null : (yield* resolveProject(index, input.project)).projectId;
      }
      if (input.milestone !== undefined) {
        if (input.milestone === null) {
          patch.milestoneId = null;
        } else {
          const projectId = patch.projectId === undefined ? issue.projectId : patch.projectId;
          if (projectId === null) {
            return yield* invalid(
              "A task must belong to a project before it can be assigned to a milestone.",
              issue.key,
            );
          }
          patch.milestoneId = (yield* resolveMilestone(index, input.milestone, projectId)).id;
        }
      }
      if (input.cycle !== undefined) {
        patch.cycleId =
          input.cycle === null
            ? null
            : (yield* resolveCycle(index, input.cycle, scopedCatalog.cycles)).id;
      }
      if (input.dueDate !== undefined) patch.dueDate = input.dueDate;
      if (input.parentKey !== undefined) {
        patch.parentId =
          input.parentKey === null ? null : (yield* resolveIssue(index, input.parentKey)).id;
      }
      if (input.triage !== undefined) patch.triage = input.triage;

      if (
        input.labels !== undefined &&
        (input.addLabels !== undefined || input.removeLabels !== undefined)
      ) {
        return yield* invalid(
          "Send either labels (replace the whole set) or addLabels/removeLabels (adjust it), not both.",
          issue.key,
        );
      }
      if (input.labels !== undefined) {
        patch.labelIds = yield* resolveLabelIds(tracker, scopedCatalog.labels, input.labels);
      } else if (input.addLabels !== undefined || input.removeLabels !== undefined) {
        const added = yield* resolveLabelIds(tracker, scopedCatalog.labels, input.addLabels ?? []);
        const scopedLabelById = new Map(scopedCatalog.labels.map((label) => [label.id, label]));
        const removedNames = new Set((input.removeLabels ?? []).map(normalizeName));
        const kept = issue.labelIds.filter((id) => {
          const label = scopedLabelById.get(id);
          return label === undefined || !removedNames.has(normalizeName(label.name));
        });
        patch.labelIds = [...new Set([...kept, ...added])];
      }

      const updated = yield* tracker.update({ issueId: issue.id, patch }, actor);
      const after = yield* readIndex();
      return { issue: formatIssueRow(after, updated.issue) };
    }).pipe(withinPinnedRoute),

  issues_comment: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const actor = yield* callerActor();
      const index = yield* readIndex();
      const issue = yield* resolveIssue(index, input.key);
      const attachmentIds = yield* storeFiles(issue, input.files ?? []);
      const created = yield* tracker.commentCreate(
        {
          issueId: issue.id,
          body: input.body,
          ...(attachmentIds.length === 0 ? {} : { attachmentIds }),
        },
        actor,
      );
      return {
        key: issue.key,
        comment: formatMcpComment(created.comment),
      };
    }).pipe(withinPinnedRoute),

  issues_comment_evidence: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const actor = yield* callerActor();
      const index = yield* readIndex();
      const issue = yield* resolveIssue(index, input.key);
      const scope = yield* McpInvocationContext.requireMcpCapability("preview").pipe(
        Effect.mapError(evidenceFailure),
      );
      const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;

      let mimeType: "image/png" | "video/mp4" | "video/webm";
      let bytes: Uint8Array;
      if (input.evidence._tag === "screenshot") {
        const snapshot = yield* broker
          .invoke<PreviewAutomationSnapshot>({
            scope,
            operation: "snapshot",
            input: {},
            ...(input.evidence.tabId === undefined ? {} : { tabId: input.evidence.tabId }),
          })
          .pipe(Effect.mapError(evidenceFailure));
        mimeType = "image/png";
        bytes = Buffer.from(snapshot.screenshot.data, "base64");
      } else {
        const artifact = input.evidence.artifact;
        const artifactMimeType = artifact.mimeType.trim().toLowerCase().split(";", 1)[0];
        if (artifactMimeType !== "video/mp4" && artifactMimeType !== "video/webm") {
          return yield* invalid(
            `Preview recording ${artifact.id} has unsupported type ${artifact.mimeType}.`,
            issue.key,
          );
        }
        if (
          artifact.sizeBytes <= 0 ||
          artifact.sizeBytes > ISSUE_COMMENT_EVIDENCE_VIDEO_MAX_BYTES
        ) {
          return yield* invalid(
            `Preview recording ${artifact.id} is empty or larger than the 25 MB evidence limit.`,
            issue.key,
          );
        }
        const chunks: Buffer[] = [];
        let offset = 0;
        while (offset < artifact.sizeBytes) {
          const chunk = yield* broker
            .invoke<PreviewAutomationRecordingChunk>({
              scope,
              operation: "recordingStop",
              input: {
                artifactRead: {
                  path: artifact.path,
                  offset,
                  length: Math.min(
                    PREVIEW_AUTOMATION_RECORDING_CHUNK_MAX_BYTES,
                    artifact.sizeBytes - offset,
                  ),
                },
              },
              timeoutMs: 60_000,
            })
            .pipe(Effect.mapError(evidenceFailure));
          const decoded = Buffer.from(chunk.data, "base64");
          if (
            chunk.offset !== offset ||
            chunk.totalBytes !== artifact.sizeBytes ||
            chunk.nextOffset !== offset + decoded.byteLength ||
            decoded.byteLength === 0
          ) {
            return yield* invalid(
              `Preview recording ${artifact.id} changed or returned an invalid chunk while it was being attached.`,
              issue.key,
            );
          }
          chunks.push(decoded);
          offset = chunk.nextOffset;
        }
        mimeType = artifactMimeType;
        bytes = Buffer.concat(chunks, artifact.sizeBytes);
      }

      const stored = yield* tracker.storeCommentFile({
        issueId: issue.id,
        fileName: mimeType === "image/png" ? "screenshot.png" : `recording.${mimeType.slice(6)}`,
        mimeType,
        bytes,
      });
      const created = yield* tracker.commentCreate(
        { issueId: issue.id, body: input.body, attachmentIds: [stored.attachmentId] },
        actor,
      );
      return { key: issue.key, comment: formatMcpComment(created.comment) };
    }).pipe(withinPinnedRoute),

  issues_delete: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const actor = yield* callerActor();
      const index = yield* readIndex();
      const issue = yield* resolveIssue(index, input.key);
      const removed = yield* tracker.remove({ issueId: issue.id }, actor);
      return { issue: formatIssueRow(index, removed.issue) };
    }).pipe(withinPinnedRoute),

  issues_restore: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const actor = yield* callerActor();
      const index = yield* readIndex();
      const key = IssueKey.make(normalizeIssueKey(input.key));
      const restored = yield* tracker.restoreByKey(key, actor);
      return { issue: formatIssueRow(index, restored.issue) };
    }).pipe(withinPinnedRoute),

  issues_link_thread: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const actor = yield* callerActor();
      const index = yield* readIndex();
      const issue = yield* resolveIssue(index, input.key);
      // The credential is issued per thread, so "my thread" is knowable without the agent being
      // told what it is — which is the only reason this tool can default at all.
      const threadId =
        input.threadId === undefined || input.threadId.trim().length === 0
          ? invocation.threadId
          : ThreadId.make(input.threadId.trim());
      const links = yield* tracker.linkThread(
        { issueId: issue.id, threadId, origin: "manual" },
        actor,
      );
      return {
        key: issue.key,
        threads: links.links.map((link) => ({
          threadId: link.threadId,
          origin: link.origin,
          createdAt: link.createdAt,
        })),
      };
    }).pipe(withinPinnedRoute),

  issues_comment_update: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const actor = yield* callerActor();
      const issue = yield* resolveIssue(yield* readIndex(), input.key);
      const detail = yield* tracker.getDetail({ issueId: issue.id });
      const comment = yield* numbered(detail.comments, input.comment, "comment", issue.key);
      const updated = yield* tracker.commentUpdate(
        { commentId: comment.id, patch: { body: input.body } },
        actor,
      );
      return { key: issue.key, comment: formatMcpComment(updated.comment) };
    }).pipe(withinPinnedRoute),

  issues_comment_delete: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const actor = yield* callerActor();
      const issue = yield* resolveIssue(yield* readIndex(), input.key);
      const detail = yield* tracker.getDetail({ issueId: issue.id });
      const comment = yield* numbered(detail.comments, input.comment, "comment", issue.key);
      const remaining = yield* tracker.commentDelete({ commentId: comment.id }, actor);
      return {
        key: issue.key,
        comments: remaining.comments.map((comment) => formatMcpComment(comment)),
      };
    }).pipe(withinPinnedRoute),

  issues_todo_create: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const issue = yield* resolveIssue(yield* readIndex(), input.key);
      const result = yield* tracker.todoCreate({ issueId: issue.id, text: input.text });
      return { key: issue.key, todos: result.todos.map(({ text, done }) => ({ text, done })) };
    }).pipe(withinPinnedRoute),

  issues_todo_update: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const issue = yield* resolveIssue(yield* readIndex(), input.key);
      const detail = yield* tracker.getDetail({ issueId: issue.id });
      const todo = yield* numbered(detail.todos, input.todo, "checklist item", issue.key);
      const result = yield* tracker.todoUpdate({
        todoId: todo.id,
        patch: {
          ...(input.text === undefined ? {} : { text: input.text }),
          ...(input.done === undefined ? {} : { done: input.done }),
        },
      });
      return { key: issue.key, todos: result.todos.map(({ text, done }) => ({ text, done })) };
    }).pipe(withinPinnedRoute),

  issues_todo_delete: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const issue = yield* resolveIssue(yield* readIndex(), input.key);
      const detail = yield* tracker.getDetail({ issueId: issue.id });
      const todo = yield* numbered(detail.todos, input.todo, "checklist item", issue.key);
      const result = yield* tracker.todoDelete({ todoId: todo.id });
      return { key: issue.key, todos: result.todos.map(({ text, done }) => ({ text, done })) };
    }).pipe(withinPinnedRoute),

  issues_todos_reorder: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const issue = yield* resolveIssue(yield* readIndex(), input.key);
      const detail = yield* tracker.getDetail({ issueId: issue.id });
      if (
        input.order.length !== detail.todos.length ||
        new Set(input.order).size !== input.order.length
      ) {
        return yield* invalid(
          `List each of ${issue.key}'s ${detail.todos.length} checklist items exactly once.`,
          issue.key,
        );
      }
      const todoIds: Array<IssueTodoId> = [];
      for (const position of input.order) {
        todoIds.push((yield* numbered(detail.todos, position, "checklist item", issue.key)).id);
      }
      const result = yield* tracker.todosReorder({ issueId: issue.id, todoIds });
      return { key: issue.key, todos: result.todos.map(({ text, done }) => ({ text, done })) };
    }).pipe(withinPinnedRoute),

  issues_relation_create: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const actor = yield* callerActor();
      const index = yield* readIndex();
      const issue = yield* resolveIssue(index, input.key);
      const other = yield* resolveIssue(index, input.otherKey);
      yield* tracker.relationCreate(relationEnds(input.relation, issue, other), actor);
      const detail = yield* tracker.getDetail({ issueId: issue.id });
      return { key: issue.key, relations: formatRelations(index, detail.relations) };
    }).pipe(withinPinnedRoute),

  issues_relation_delete: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const actor = yield* callerActor();
      const index = yield* readIndex();
      const issue = yield* resolveIssue(index, input.key);
      const other = yield* resolveIssue(index, input.otherKey);
      const ends = relationEnds(input.relation, issue, other);
      const detail = yield* tracker.getDetail({ issueId: issue.id });
      const edge = detail.relations.find(
        ({ relation }) =>
          relation.kind === ends.kind &&
          ((relation.issueId === ends.issueId && relation.relatedIssueId === ends.relatedIssueId) ||
            // "relates to" reads the same from both sides, so either stored direction matches.
            (ends.kind === "relates" &&
              relation.issueId === ends.relatedIssueId &&
              relation.relatedIssueId === ends.issueId)),
      );
      if (edge === undefined) {
        return yield* notFound(
          `No "${issue.key} ${input.relation} ${other.key}" link exists. Use issues_get to see its links.`,
          issue.key,
        );
      }
      yield* tracker.relationDelete({ relationId: edge.relation.id }, actor);
      const after = yield* tracker.getDetail({ issueId: issue.id });
      return { key: issue.key, relations: formatRelations(index, after.relations) };
    }).pipe(withinPinnedRoute),

  issues_unlink_thread: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const actor = yield* callerActor();
      const issue = yield* resolveIssue(yield* readIndex(), input.key);
      const threadId =
        input.threadId === undefined || input.threadId.trim().length === 0
          ? invocation.threadId
          : ThreadId.make(input.threadId.trim());
      const links = yield* tracker.unlinkThread({ issueId: issue.id, threadId }, actor);
      return {
        key: issue.key,
        threads: links.links.map((link) => ({
          threadId: link.threadId,
          origin: link.origin,
          createdAt: link.createdAt,
        })),
      };
    }).pipe(withinPinnedRoute),

  issues_history: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const index = yield* readIndex();
      const issue = yield* resolveIssue(index, input.key);
      const { events } = yield* tracker.getEvents({ issueId: issue.id });
      return {
        key: issue.key,
        events: [...events]
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
          .map((event) => ({
            at: event.createdAt,
            actor: formatIssueActor(event.actor, index),
            kind: event.kind,
            field: event.field,
            before: event.before,
            after: event.after,
          })),
      };
    }).pipe(withinPinnedRoute),

  issues_triage_accept: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const actor = yield* callerActor();
      const index = yield* readIndex();
      const issue = yield* resolveIssue(index, input.key);
      const project =
        input.project === undefined || input.project === null
          ? input.project
          : yield* resolveProject(index, input.project);
      const projectId =
        project === undefined ? issue.projectId : project === null ? null : project.projectId;
      const status = yield* resolveStatus(
        index,
        input.status,
        yield* tracker.statusesForProject({ projectId }),
      );
      const assignee =
        input.assignee === undefined || input.assignee === null
          ? input.assignee
          : yield* resolveIssueAssignee(tracker, input.assignee, actor.provider);
      const accepted = yield* tracker.triageAccept(
        {
          issueId: issue.id,
          statusId: status.id,
          ...(project === undefined ? {} : { projectId: project?.projectId ?? null }),
          ...(input.priority === undefined ? {} : { priority: input.priority }),
          ...(assignee === undefined ? {} : { assignee }),
          runEnrichment: input.investigate ?? false,
        },
        actor,
      );
      const after = yield* readIndex();
      return {
        issue: formatIssueRow(after, accepted.issue),
        investigation:
          input.investigate === true
            ? (accepted.enrichmentRefusal ?? (accepted.enrichmentRun === null ? null : "started"))
            : null,
      };
    }).pipe(withinPinnedRoute),

  issues_triage_reject: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const actor = yield* callerActor();
      const index = yield* readIndex();
      const issue = yield* resolveIssue(index, input.key);
      const rejected = yield* tracker.triageReject({ issueId: issue.id }, actor);
      return { issue: formatIssueRow(index, rejected.issue) };
    }).pipe(withinPinnedRoute),

  issues_cycles_list: () =>
    Effect.gen(function* () {
      const index = yield* readIndex();
      return {
        cycles: [...index.cycles]
          .sort((left, right) => left.startDate.localeCompare(right.startDate))
          .map(formatCycle),
      };
    }).pipe(withinPinnedRoute),

  issues_cycle_create: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const created = yield* tracker.cycleCreate(input);
      return { cycle: formatCycle(created.cycle) };
    }).pipe(withinPinnedRoute),

  issues_cycle_update: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const index = yield* readIndex();
      const cycle = yield* resolveNamed(index.cycles, input.cycle, "cycle");
      const updated = yield* tracker.cycleUpdate({
        cycleId: cycle.id,
        patch: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.startDate === undefined ? {} : { startDate: input.startDate }),
          ...(input.endDate === undefined ? {} : { endDate: input.endDate }),
        },
      });
      return { cycle: formatCycle(updated.cycle) };
    }).pipe(withinPinnedRoute),

  issues_cycle_delete: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const actor = yield* callerActor();
      const index = yield* readIndex();
      const cycle = yield* resolveNamed(index.cycles, input.cycle, "cycle");
      const remaining = yield* tracker.cycleDelete({ cycleId: cycle.id }, actor);
      return { cycles: remaining.cycles.map(formatCycle) };
    }).pipe(withinPinnedRoute),

  issues_milestones_reorder: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const index = yield* readIndex();
      const project = yield* resolveProject(index, input.project);
      const milestones = index.milestones.filter(
        (milestone) => milestone.projectId === project.projectId,
      );
      const milestoneIds = yield* orderByNames(milestones, input.milestones, "milestone");
      const result = yield* tracker.milestonesReorder({
        projectId: project.projectId,
        milestoneIds: [...milestoneIds],
      });
      return {
        milestones: result.milestones
          .filter((milestone) => milestone.projectId === project.projectId)
          .map((milestone) => formatMilestone(index, milestone)),
      };
    }).pipe(withinPinnedRoute),

  issues_milestone_history: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const index = yield* readIndex();
      const project = yield* resolveProject(index, input.project);
      const milestone = yield* resolveMilestone(index, input.milestone, project.projectId);
      const history = yield* tracker.milestoneHistory({ milestoneId: milestone.id });
      return { milestone: milestone.name, ...history };
    }).pipe(withinPinnedRoute),

  issues_members_list: () =>
    Effect.gen(function* () {
      const index = yield* readIndex();
      return {
        members: [...index.memberById.values()]
          .filter((member) => member.active)
          .sort((left, right) => left.displayName.localeCompare(right.displayName))
          .map((member) => ({
            name: member.displayName,
            email: member.email,
            assignee: `member:${member.membershipId}`,
          })),
      };
    }).pipe(withinPinnedRoute),

  issues_labels_list: () =>
    Effect.gen(function* () {
      const index = yield* readIndex();
      return { labels: index.snapshot.labels.map(formatLabel) };
    }).pipe(withinPinnedRoute),

  issues_label_create: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const index = yield* readIndex();
      const created = yield* tracker.createLabel({
        name: input.name,
        color:
          input.color ??
          AGENT_LABEL_COLORS[index.snapshot.labels.length % AGENT_LABEL_COLORS.length]!,
      });
      return { label: formatLabel(created.label) };
    }).pipe(withinPinnedRoute),

  issues_label_update: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const index = yield* readIndex();
      const label = yield* resolveNamed(index.snapshot.labels, input.label, "label");
      const updated = yield* tracker.updateLabel({
        labelId: label.id,
        patch: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.color === undefined ? {} : { color: input.color }),
        },
      });
      return { label: formatLabel(updated.label) };
    }).pipe(withinPinnedRoute),

  issues_label_delete: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const index = yield* readIndex();
      const label = yield* resolveNamed(index.snapshot.labels, input.label, "label");
      const remaining = yield* tracker.deleteLabel({ labelId: label.id });
      return { labels: remaining.labels.map(formatLabel) };
    }).pipe(withinPinnedRoute),

  issues_statuses_list: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const index = yield* readIndex();
      const statuses =
        input.project === undefined
          ? index.statuses
          : yield* tracker.statusesForProject({
              projectId: (yield* resolveProject(index, input.project)).projectId,
            });
      return { statuses: [...statuses].sort(byPosition).map(formatStatus) };
    }).pipe(withinPinnedRoute),

  issues_status_create: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const index = yield* readIndex();
      const created = yield* tracker.createStatus({
        name: input.name,
        category: input.category,
        color:
          input.color ?? AGENT_LABEL_COLORS[index.statuses.length % AGENT_LABEL_COLORS.length]!,
      });
      return { status: formatStatus(created.status) };
    }).pipe(withinPinnedRoute),

  issues_status_update: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const index = yield* readIndex();
      const status = yield* resolveNamed(index.statuses, input.status, "status");
      const updated = yield* tracker.updateStatus({
        statusId: status.id,
        patch: {
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.category === undefined ? {} : { category: input.category }),
          ...(input.color === undefined ? {} : { color: input.color }),
        },
      });
      return { status: formatStatus(updated.status) };
    }).pipe(withinPinnedRoute),

  issues_status_delete: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const actor = yield* callerActor();
      const index = yield* readIndex();
      const status = yield* resolveNamed(index.statuses, input.status, "status");
      const target = yield* resolveNamed(index.statuses, input.moveTasksTo, "status");
      const remaining = yield* tracker.deleteStatus(
        { statusId: status.id, reassignToStatusId: target.id },
        actor,
      );
      return { statuses: [...remaining.statuses].sort(byPosition).map(formatStatus) };
    }).pipe(withinPinnedRoute),

  issues_statuses_reorder: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const index = yield* readIndex();
      const statusIds = yield* orderByNames(index.statuses, input.statuses, "status");
      const result = yield* tracker.reorderStatuses({ statusIds: [...statusIds] });
      return { statuses: [...result.statuses].sort(byPosition).map(formatStatus) };
    }).pipe(withinPinnedRoute),
} satisfies Parameters<typeof IssuesToolkit.toLayer>[0];

export const IssuesToolkitHandlersLive = IssuesToolkit.toLayer(handlers);
