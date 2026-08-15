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
  type IssuesSnapshot,
  ISSUE_COMMENT_EVIDENCE_VIDEO_MAX_BYTES,
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

import {
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

/** How an actor reads in a tool result: `user`, `member:<id>`, `agent:codex`, `system:import`. */
export const formatIssueActor = (actor: IssueActor | null): string | null => {
  if (actor === null) return null;
  switch (actor.kind) {
    case "user":
      return "user";
    // The membership id is the only identity a member carries; there is no name to print yet.
    case "member":
      return `member:${actor.membershipId}`;
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
    const membershipId = token.slice("member:".length).trim();
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
}

const buildIndex = (
  snapshot: IssuesSnapshot,
  projects: ReadonlyArray<ProjectionProject>,
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
  };
};

const readIndex = Effect.fn("issues_mcp.readIndex")(function* () {
  const tracker = yield* IssueTrackerService;
  const projectRepository = yield* ProjectionProjectRepository;
  const snapshot = yield* tracker.getSnapshot();
  const projects = yield* projectRepository
    .listAll()
    .pipe(Effect.mapError(() => storage("Failed to read the project list.")));
  return buildIndex(snapshot, projects);
});

/** The agent behind this MCP credential, as the tracker records it. */
const callerActor = Effect.fn("issues_mcp.actor")(function* () {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  return { kind: "agent", provider: invocation.providerDriverKind } as const satisfies IssueActor;
});

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
          `No issue with key "${normalized}". Use issues_list to find the key you meant.`,
          normalized,
        ),
      );
};

/**
 * A status name, or a category standing in for one. The category form is the one that matters:
 * "completed" is a fact about the workflow, while the name of the done column is a local decision
 * an agent cannot know.
 */
const resolveStatus = (
  index: TrackerIndex,
  value: string,
): Effect.Effect<IssueStatus, IssueTrackerError> => {
  const wanted = normalizeName(value);
  const byName = index.statuses.find((status) => normalizeName(status.name) === wanted);
  if (byName) return Effect.succeed(byName);
  const byCategory = index.statuses.find((status) => status.category === wanted);
  if (byCategory) return Effect.succeed(byCategory);
  return Effect.fail(
    notFound(
      `No issue status called "${value.trim()}". Valid statuses: ${quoteOptions(
        index.statuses.map((status) => status.name),
      )}. Valid categories: ${quoteOptions(ISSUE_STATUS_CATEGORIES)}.`,
      value.trim(),
    ),
  );
};

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
): Effect.Effect<IssueMilestone, IssueTrackerError> => {
  const wanted = normalizeName(value);
  const milestone = index.milestones.find((candidate) => normalizeName(candidate.name) === wanted);
  return milestone
    ? Effect.succeed(milestone)
    : Effect.fail(
        notFound(
          `No milestone called "${value.trim()}". Valid milestones: ${quoteOptions(
            index.milestones.map((candidate) => candidate.name),
          )}.`,
          value.trim(),
        ),
      );
};

const resolveCycle = (
  index: TrackerIndex,
  value: string,
): Effect.Effect<IssueCycle, IssueTrackerError> => {
  const wanted = normalizeName(value);
  const cycle = index.cycles.find((candidate) => normalizeName(candidate.name) === wanted);
  return cycle
    ? Effect.succeed(cycle)
    : Effect.fail(
        notFound(
          `No cycle called "${value.trim()}". Valid cycles: ${quoteOptions(
            index.cycles.map((candidate) => candidate.name),
          )}.`,
          value.trim(),
        ),
      );
};

export const resolveIssueAssignee = (
  tracker: Pick<IssueTrackerServiceShape, "replicaRoutable" | "linkedMemberActor">,
  value: string,
  self: ProviderDriverKind,
): Effect.Effect<IssueAssignee | null, IssueTrackerError> =>
  Effect.gen(function* () {
    const parsed = parseIssueAssignee(value, self);
    if (parsed === undefined) {
      return yield* invalid(
        `Cannot read "${value.trim()}" as an assignee. Use "user" for the bound company member, "member:<membership-id>" for an explicit member, "agent" for yourself, "agent:<driver>" for another provider such as "agent:codex", or "none" to leave it unassigned.`,
        value.trim(),
      );
    }
    if (parsed?.kind !== "user") return parsed;
    if (!(yield* tracker.replicaRoutable)) return parsed;
    const member = yield* tracker.linkedMemberActor;
    return (
      member ??
      (yield* invalid(
        'This environment has no active bound company membership. Pass an explicit "member:<membership-id>" assignee.',
        value.trim(),
      ))
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
        author: formatIssueActor(comment.author) ?? "unknown",
        commentBody: comment.body,
        commentCreatedAt: comment.createdAt,
      });
    }
  }
  return attachments;
};

const formatMcpComment = (comment: IssueDetail["comments"][number]) => ({
  author: formatIssueActor(comment.author) ?? "unknown",
  body: comment.body,
  attachmentIds: comment.attachmentIds,
  createdAt: comment.createdAt,
  editedAt: comment.editedAt,
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
    assignee: formatIssueActor(issue.assignee),
    project: project?.title ?? null,
    parentKey: parent?.key ?? null,
    dueDate: issue.dueDate,
    triage: issue.triage,
    deletedAt: issue.deletedAt,
  };
};

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
    relations: detail.relations.flatMap((edge) => {
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
    }),
    comments: detail.comments.map(formatMcpComment),
    attachments: formatIssueAttachments(detail.comments),
    threads: threads.map((link) => ({
      threadId: link.threadId,
      origin: link.origin,
      createdAt: link.createdAt,
    })),
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
};

/** Newest-updated first. An agent asking "what is going on" means recency, not board position. */
const byRecency = (left: Issue, right: Issue): number =>
  right.updatedAt.localeCompare(left.updatedAt) || left.key.localeCompare(right.key);

const handlers = {
  issues_list: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const invocation = yield* McpInvocationContext.McpInvocationContext;
      const index = yield* readIndex();
      const status = input.status === undefined ? null : yield* resolveStatus(index, input.status);
      const project =
        input.project === undefined ? null : yield* resolveProject(index, input.project);
      const assignee =
        input.assignee === undefined
          ? undefined
          : yield* resolveIssueAssignee(tracker, input.assignee, invocation.providerDriverKind);
      let labelId: IssueLabelId | null = null;
      if (input.label !== undefined) {
        const wanted = normalizeName(input.label);
        const label = index.snapshot.labels.find(
          (candidate) => normalizeName(candidate.name) === wanted,
        );
        if (!label) {
          return yield* notFound(
            `No label called "${input.label.trim()}". Valid labels: ${quoteOptions(
              index.snapshot.labels.map((candidate) => candidate.name),
            )}.`,
            input.label.trim(),
          );
        }
        labelId = label.id;
      }
      const query = input.query === undefined ? null : normalizeName(input.query);
      const includeDeleted = input.includeDeleted ?? false;

      const matched = index.snapshot.issues
        .filter((issue) => {
          if (!includeDeleted && issue.deletedAt !== null) return false;
          if (input.triage !== undefined && issue.triage !== input.triage) return false;
          if (status !== null && issue.statusId !== status.id) return false;
          if (input.statusCategory !== undefined) {
            const category = index.statusById.get(issue.statusId)?.category;
            if (category !== input.statusCategory) return false;
          }
          if (project !== null && issue.projectId !== project.projectId) return false;
          if (labelId !== null && !issue.labelIds.includes(labelId)) return false;
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
    }),

  issues_get: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const index = yield* readIndex();
      const issue = yield* resolveIssue(index, input.key);
      const detail = yield* tracker.getDetail({ issueId: issue.id });
      const links = yield* tracker.getThreadLinks({ issueId: issue.id });
      return formatIssueDetail(index, issue, detail, links.links);
    }),

  issues_get_attachment: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const index = yield* readIndex();
      const issue = yield* resolveIssue(index, input.key);
      const detail = yield* tracker.getDetail({ issueId: issue.id });
      const attachmentId = input.attachmentId.trim();
      const attachment = formatIssueAttachments(detail.comments).find(
        (candidate) => candidate.attachmentId === attachmentId,
      );
      if (attachment === undefined) {
        return yield* notFound(
          `No attachment ${attachmentId || "(empty)"} belongs to ${issue.key}.`,
          attachmentId,
        );
      }
      return { key: issue.key, attachment };
    }),

  issues_create: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const actor = yield* callerActor();
      const index = yield* readIndex();

      const status = input.status === undefined ? null : yield* resolveStatus(index, input.status);
      const project =
        input.project === undefined ? null : yield* resolveProject(index, input.project);
      const milestone =
        input.milestone === undefined ? null : yield* resolveMilestone(index, input.milestone);
      const cycle = input.cycle === undefined ? null : yield* resolveCycle(index, input.cycle);
      const parent =
        input.parentKey === undefined ? null : yield* resolveIssue(index, input.parentKey);
      const assignee =
        input.assignee === undefined
          ? undefined
          : yield* resolveIssueAssignee(tracker, input.assignee, actor.provider);
      const labelIds =
        input.labels === undefined
          ? undefined
          : yield* resolveLabelIds(tracker, index.snapshot.labels, input.labels);

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
      const created = yield* tracker.create(create, actor);
      // `create` takes no assignee: assignment is a field change, and the change log should say so
      // rather than hiding an owner inside a "created" row.
      const issue =
        assignee === undefined
          ? created.issue
          : (yield* tracker.update({ issueId: created.issue.id, patch: { assignee } }, actor))
              .issue;
      const after = yield* readIndex();
      return { issue: formatIssueRow(after, issue) };
    }),

  issues_update: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const actor = yield* callerActor();
      const index = yield* readIndex();
      const issue = yield* resolveIssue(index, input.key);

      const patch: {
        -readonly [K in keyof IssuePatch]: IssuePatch[K];
      } = {};
      if (input.title !== undefined) patch.title = input.title;
      if (input.description !== undefined) patch.description = input.description;
      if (input.status !== undefined) {
        patch.statusId = (yield* resolveStatus(index, input.status)).id;
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
        patch.milestoneId =
          input.milestone === null ? null : (yield* resolveMilestone(index, input.milestone)).id;
      }
      if (input.cycle !== undefined) {
        patch.cycleId = input.cycle === null ? null : (yield* resolveCycle(index, input.cycle)).id;
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
        patch.labelIds = yield* resolveLabelIds(tracker, index.snapshot.labels, input.labels);
      } else if (input.addLabels !== undefined || input.removeLabels !== undefined) {
        const added = yield* resolveLabelIds(tracker, index.snapshot.labels, input.addLabels ?? []);
        const removedNames = new Set((input.removeLabels ?? []).map(normalizeName));
        const kept = issue.labelIds.filter((id) => {
          const label = index.labelById.get(id);
          return label === undefined || !removedNames.has(normalizeName(label.name));
        });
        patch.labelIds = [...new Set([...kept, ...added])];
      }

      const updated = yield* tracker.update({ issueId: issue.id, patch }, actor);
      const after = yield* readIndex();
      return { issue: formatIssueRow(after, updated.issue) };
    }),

  issues_comment: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const actor = yield* callerActor();
      const index = yield* readIndex();
      const issue = yield* resolveIssue(index, input.key);
      const created = yield* tracker.commentCreate({ issueId: issue.id, body: input.body }, actor);
      return {
        key: issue.key,
        comment: formatMcpComment(created.comment),
      };
    }),

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

      const stored = yield* tracker.storeCommentEvidence({ issueId: issue.id, mimeType, bytes });
      const created = yield* tracker.commentCreate(
        { issueId: issue.id, body: input.body, attachmentIds: [stored.attachmentId] },
        actor,
      );
      return { key: issue.key, comment: formatMcpComment(created.comment) };
    }),

  issues_delete: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const actor = yield* callerActor();
      const index = yield* readIndex();
      const issue = yield* resolveIssue(index, input.key);
      const removed = yield* tracker.remove({ issueId: issue.id }, actor);
      return { issue: formatIssueRow(index, removed.issue) };
    }),

  issues_restore: (input) =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      const actor = yield* callerActor();
      const index = yield* readIndex();
      const issue = yield* resolveIssue(index, input.key);
      const restored = yield* tracker.restore({ issueId: issue.id }, actor);
      return { issue: formatIssueRow(index, restored.issue) };
    }),

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
    }),
} satisfies Parameters<typeof IssuesToolkit.toLayer>[0];

export const IssuesToolkitHandlersLive = IssuesToolkit.toLayer(handlers);
