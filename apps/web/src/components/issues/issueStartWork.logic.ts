/**
 * Start work: the seed a thread opens holding, and the note that says which issue it came from.
 *
 * Assigning an agent records intent and nothing else — the decision record is explicit that a
 * stray kanban drag must not start three agents — so this composes text and hands it to the
 * existing new-thread flow. Nothing here sends anything.
 *
 * The link is the awkward half. `useNewThreadHandler` mints the thread id client-side and the
 * server materialises *that* id when the composer is finally sent, so the id is known at the
 * press. Writing the link then would record a thread for every draft anybody opened and
 * abandoned, and the server does not check that a thread exists. So the press only remembers the
 * intent, keyed by draft, and the draft route writes the link once the thread actually appears.
 *
 * @module components/issues/issueStartWork.logic
 */
import type { Issue, IssueId, IssueTodo } from "@t3tools/contracts";

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
 * The closing line is the only instruction, and it is deliberately not a plan: the thread is
 * opened *unsent*, so the reader gets to edit or delete every word of this before anything runs.
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

  blocks.push(
    "Start by reading the issue and the code it points at. Keep the issue current as you go — the issues tools can move its status, tick its checklist, and comment on it.",
  );

  return `${blocks.join("\n\n")}\n`;
}

/** What the checklist and relations look like once the todo rows are ordered. */
export function issueStartWorkTodos(todos: ReadonlyArray<IssueTodo>): ReadonlyArray<IssueTodo> {
  return [...todos].sort(
    (left, right) => left.position - right.position || left.id.localeCompare(right.id),
  );
}

// ── The pending link ───────────────────────────────────────────────────

export const ISSUE_PENDING_THREAD_LINK_STORAGE_KEY = "pathway:issues:pending-thread-links";

/**
 * Bounded so an abandoned draft cannot grow the record without limit. Small on purpose: this is a
 * hand-off that lives for the seconds between opening a composer and sending it, not a queue.
 */
const MAX_PENDING_LINKS = 20;

/** The three methods used, so a test can pass a plain object and the caller passes `sessionStorage`. */
export type PendingLinkStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function readPendingLinks(storage: PendingLinkStorage): Record<string, string> {
  let raw: string | null = null;
  try {
    raw = storage.getItem(ISSUE_PENDING_THREAD_LINK_STORAGE_KEY);
  } catch {
    // A storage that throws on read (private mode, a disabled origin) means no pending links,
    // which costs the reader a manual link rather than a broken button.
    return {};
  }
  if (raw === null) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const entries: Array<[string, string]> = [];
    for (const [draftId, issueId] of Object.entries(parsed)) {
      if (typeof issueId === "string" && issueId.length > 0) entries.push([draftId, issueId]);
    }
    return Object.fromEntries(entries);
  } catch {
    return {};
  }
}

function writePendingLinks(storage: PendingLinkStorage, links: Record<string, string>): void {
  try {
    const entries = Object.entries(links);
    if (entries.length === 0) {
      storage.removeItem(ISSUE_PENDING_THREAD_LINK_STORAGE_KEY);
      return;
    }
    storage.setItem(
      ISSUE_PENDING_THREAD_LINK_STORAGE_KEY,
      JSON.stringify(Object.fromEntries(entries)),
    );
  } catch {
    // Nothing to do: the link is a convenience, and the Threads section can be filled by hand.
  }
}

/** Records "the thread this draft becomes belongs to this issue". Last write per draft wins. */
export function rememberPendingIssueThreadLink(
  storage: PendingLinkStorage,
  draftId: string,
  issueId: IssueId,
): void {
  const links = readPendingLinks(storage);
  delete links[draftId];
  const entries = [...Object.entries(links), [draftId, issueId] as const];
  writePendingLinks(
    storage,
    Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_PENDING_LINKS))),
  );
}

/** Reads and clears in one step, so a re-render cannot write the same link twice. */
export function takePendingIssueThreadLink(
  storage: PendingLinkStorage,
  draftId: string,
): IssueId | null {
  const links = readPendingLinks(storage);
  const issueId = links[draftId];
  if (issueId === undefined) return null;
  delete links[draftId];
  writePendingLinks(storage, links);
  return issueId as IssueId;
}
