/**
 * Start work: the seed dispatched as a thread, its workflow destination, and its image context.
 *
 * Assigning an agent records intent and nothing else — the decision record is explicit that a
 * stray kanban drag must not start three agents — so this composes text and hands it to the
 * existing new-thread flow. The explicit Start work press dispatches that first turn immediately;
 * assigning an agent by itself remains intent only.
 *
 * @module components/issues/issueStartWork.logic
 */
import type {
  ChatAttachmentId,
  Issue,
  IssueComment,
  IssueStatus,
  IssueStatusId,
  IssueTodo,
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@t3tools/contracts";
import { createModelSelection, resolveSelectableModel } from "@t3tools/shared/model";

import type { ProviderInstanceEntry } from "~/providerInstances";
import { resolveSelectableProviderInstanceEntry } from "~/providerInstances";
import type { ModelEsque } from "../chat/providerIconUtils";
import { issueAttachmentIds } from "./issueCommentAttachments";

export type IssueStartWorkWorkspaceMode = "current_checkout" | "new_worktree";

export interface IssueStartWorkWorkspacePlan {
  readonly envMode: "local" | "worktree";
  /** The base branch shown on the draft before a new worktree is provisioned. */
  readonly branch: string | null;
  /** Null means the first turn runs in the project's current checkout. */
  readonly prepareWorktreeBaseBranch: string | null;
}

/**
 * Resolves the issue launcher's compact workspace choice into the two pieces the normal
 * new-thread pipeline needs: draft context and, for an isolated task, first-turn worktree prep.
 */
export function resolveIssueStartWorkWorkspacePlan(
  mode: IssueStartWorkWorkspaceMode,
  currentBranch: string | null,
): IssueStartWorkWorkspacePlan | null {
  if (mode === "new_worktree") {
    if (currentBranch === null) return null;
    return {
      envMode: "worktree",
      branch: currentBranch,
      prepareWorktreeBaseBranch: currentBranch,
    };
  }
  return { envMode: "local", branch: null, prepareWorktreeBaseBranch: null };
}

// ── Model choice ──────────────────────────────────────────────────────

/**
 * The model shown beside Start work. Assignment constrains the driver; a compatible project
 * default wins, then the provider's normal ready-instance/default-model order takes over.
 */
export function resolveIssueStartWorkModelSelection(input: {
  readonly provider: ProviderDriverKind | null;
  readonly projectDefault: ModelSelection | null;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<
    ProviderInstanceId,
    ReadonlyArray<ModelEsque & { readonly isDefault?: boolean }>
  >;
}): ModelSelection | null {
  if (input.provider === null) return null;
  const compatibleEntries = input.instanceEntries.filter(
    (entry) => entry.driverKind === input.provider,
  );
  const preferredInstanceId = compatibleEntries.some(
    (entry) => entry.instanceId === input.projectDefault?.instanceId,
  )
    ? input.projectDefault?.instanceId
    : undefined;
  const entry = resolveSelectableProviderInstanceEntry(compatibleEntries, preferredInstanceId);
  if (entry === undefined) return null;

  const usesProjectDefault = input.projectDefault?.instanceId === entry.instanceId;
  const options = input.modelOptionsByInstance.get(entry.instanceId) ?? [];
  const requestedModel = usesProjectDefault ? input.projectDefault.model : null;
  const model =
    resolveSelectableModel(entry.driverKind, requestedModel, options) ??
    options.find((option) => option.isDefault)?.slug ??
    options[0]?.slug ??
    null;
  if (model === null) return null;

  return createModelSelection(
    entry.instanceId,
    model,
    usesProjectDefault && input.projectDefault !== null && model === input.projectDefault.model
      ? input.projectDefault.options
      : undefined,
  );
}

// ── Links back to the issue ────────────────────────────────────────────

/** The tracker has no per-issue route: the sheet is `?issue=` over the list. */
export function issueDetailPath(issueKey: string): string {
  return `/issues?issue=${encodeURIComponent(issueKey)}`;
}

/** Absolute, because the thread may be read on another machine's screen than the one it runs on. */
export function issueDetailUrl(origin: string, issueKey: string): string {
  return `${origin.replace(/\/+$/, "")}${issueDetailPath(issueKey)}`;
}

// ── The seed prompt ────────────────────────────────────────────────────

/** One line of the "Related" list: how it relates, what it is, and what it is called. */
export interface IssueStartWorkRelation {
  /** `Blocked by`, `Blocking`, `Sub-issue of`, `Parent of` — already read from the issue's end. */
  readonly label: string;
  readonly key: string;
  readonly title: string;
}

export interface IssueStartWorkContext {
  readonly issue: Issue;
  readonly statusName: string | null;
  readonly projectTitle: string | null;
  readonly priorityLabel: string | null;
  /** Configured workflow destination the agent should choose only after the work is actually done. */
  readonly completionStatusName?: string | null;
  readonly todos: ReadonlyArray<IssueTodo>;
  readonly relations: ReadonlyArray<IssueStartWorkRelation>;
  /** Absolute link back to the sheet, from {@link issueDetailUrl}. */
  readonly issueUrl: string;
}

function metaLine(context: IssueStartWorkContext): string | null {
  const parts: Array<string> = [];
  if (context.statusName !== null) parts.push(`Status: ${context.statusName}`);
  if (context.priorityLabel !== null) parts.push(`Priority: ${context.priorityLabel}`);
  if (context.projectTitle !== null) parts.push(`Project: ${context.projectTitle}`);
  if (context.issue.dueDate !== null) parts.push(`Due: ${context.issue.dueDate}`);
  return parts.length === 0 ? null : parts.join(" · ");
}

/**
 * Markdown, in the order a person reads an issue: what it is, where it lives, what it says, what
 * it is made of, what it touches. Empty sections are dropped rather than printed empty — a
 * "## Checklist" with nothing under it reads as a checklist the model failed to load.
 *
 * The closing line is the only instruction, and it is deliberately not a plan: this is dispatched
 * by an explicit Start work press, so the agent should begin from the issue rather than inventing
 * work beyond it.
 */
export function buildIssueStartWorkPrompt(context: IssueStartWorkContext): string {
  const { issue } = context;
  const blocks: Array<string> = [`# ${issue.key} — ${issue.title}`];

  const meta = metaLine(context);
  const header = meta === null ? context.issueUrl : `${context.issueUrl}\n${meta}`;
  blocks.push(header);

  const description = issue.description.trim();
  if (description.length > 0) blocks.push(`## Description\n${description}`);

  if (context.todos.length > 0) {
    blocks.push(
      `## Checklist\n${context.todos
        .map((todo) => `- [${todo.done ? "x" : " "}] ${todo.text}`)
        .join("\n")}`,
    );
  }

  if (context.relations.length > 0) {
    blocks.push(
      `## Related\n${context.relations
        .map((relation) => `- ${relation.label}: ${relation.key} — ${relation.title}`)
        .join("\n")}`,
    );
  }

  const completionInstruction =
    context.completionStatusName == null
      ? ""
      : ` When the implementation and its verification are genuinely finished, use \`issues_update\` to move it to ${context.completionStatusName}; that transition starts its configured audits.`;
  blocks.push(
    `Start by reading the issue with Pathway MCP's \`issues_get\` tool and then inspect the code it points at. Keep the issue current with Pathway MCP's \`issues_update\` and \`issues_comment\` tools as you go. Use only the Pathway MCP issue tools for this issue; do not use Linear or another external issue tracker.${completionInstruction}`,
  );

  return `${blocks.join("\n\n")}\n`;
}

/** What the checklist and relations look like once the todo rows are ordered. */
export function issueStartWorkTodos(todos: ReadonlyArray<IssueTodo>): ReadonlyArray<IssueTodo> {
  return [...todos].sort(
    (left, right) => left.position - right.position || left.id.localeCompare(right.id),
  );
}

/**
 * Start means active work. A configured transition wins; otherwise prefer the first active status,
 * then Todo-like unstarted work. The latter keeps custom workflows usable when they have no
 * explicit In Progress column.
 */
export function resolveIssueStartWorkStatusId(input: {
  readonly configuredStatusId: string | null;
  readonly statuses: ReadonlyArray<IssueStatus>;
}): IssueStatusId | null {
  if (input.configuredStatusId !== null) {
    const configured = input.statuses.find((status) => status.id === input.configuredStatusId);
    if (configured !== undefined) return configured.id;
  }
  return (
    input.statuses.find((status) => status.category === "started")?.id ??
    input.statuses.find((status) => status.category === "unstarted")?.id ??
    null
  );
}

/** Issue images become first-turn context, in comment order and within the provider send limit. */
export function issueStartWorkAttachmentIds(
  comments: ReadonlyArray<IssueComment>,
): ReadonlyArray<ChatAttachmentId> {
  return issueAttachmentIds(comments).slice(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS);
}
