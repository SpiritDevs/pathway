/**
 * Pure validation and derivation for the issue-domain sync operations.
 *
 * **`packages/contracts/src/cloudSync.ts` is the source of truth** for every argument shape here.
 * This package deploys to Convex and deliberately does not depend on Effect Schema, so each
 * `Sync*Args` schema is hand-mirrored as a `parse*Args` function; when the two disagree, the
 * contract wins and this file is what changes.
 *
 * Two deliberate widenings, both for rollback safety and both matching how the tables store the
 * same values: an agent assignee's `provider` is any non-empty string rather than the closed
 * `ProviderDriverKind` set, and `workModelSelection` is checked to be an object but otherwise
 * stored opaque — a value written by a newer deployment must survive being replayed through an
 * older one.
 *
 * Everything here is pure so the whole argument surface is unit-testable without a deployment.
 *
 * @module sync/issueOps
 */

// ---------------------------------------------------------------------------
// Bounds and literal sets, mirrored from `contracts/issues` and `contracts/cloudSync`
// ---------------------------------------------------------------------------

export const ISSUE_TITLE_MAX_CHARS = 512;
export const ISSUE_DESCRIPTION_MAX_CHARS = 100_000;
export const ISSUE_COMMENT_MAX_CHARS = 100_000;
export const ISSUE_COMMENT_MAX_ATTACHMENTS = 8;
export const ISSUE_LABELS_MAX_PER_ISSUE = 50;
export const ISSUE_VIEW_FILTER_MAX_VALUES = 200;

export const ISSUE_PRIORITIES = ["none", "urgent", "high", "medium", "low"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

export const ISSUE_STATUS_CATEGORIES = [
  "backlog",
  "unstarted",
  "started",
  "review",
  "completed",
  "canceled",
] as const;
export type IssueStatusCategory = (typeof ISSUE_STATUS_CATEGORIES)[number];

export const ISSUE_RELATION_KINDS = ["blocks", "relates", "duplicate"] as const;
export type IssueRelationKind = (typeof ISSUE_RELATION_KINDS)[number];

export const ISSUE_THREAD_LINK_ORIGINS = ["start-work", "manual", "mention"] as const;
export type IssueThreadLinkOrigin = (typeof ISSUE_THREAD_LINK_ORIGINS)[number];

export const ISSUE_VIEW_VISIBILITIES = ["private", "teams", "company"] as const;
export type IssueViewVisibility = (typeof ISSUE_VIEW_VISIBILITIES)[number];

export const ISSUE_VIEW_TABS = ["active", "backlog", "all"] as const;
export const ISSUE_VIEW_GROUPINGS = ["status", "project", "priority", "assignee", "none"] as const;
export const ISSUE_VIEW_SORT_MODES = ["manual", "priority", "updated", "created"] as const;
export const ISSUE_VIEW_MODES = ["list", "board"] as const;
export const ISSUE_VIEW_DUE_FILTERS = ["overdue", "week", "month", "none"] as const;

const ISSUE_COLOR_PATTERN = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const ISSUE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISSUE_KEY_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;

// ---------------------------------------------------------------------------
// Result and combinators
// ---------------------------------------------------------------------------

/** What decoding one operation's arguments produced. `message` becomes the rejection message. */
export type ArgsResult<T> =
  | { readonly ok: true; readonly args: T }
  | { readonly ok: false; readonly message: string };

/**
 * Internal control flow for the combinators below: the first failing check aborts the whole
 * decode, and the parse entry point turns the throw into an `ArgsResult`. Never escapes.
 */
class ArgError extends Error {}

function invalid(message: string): never {
  throw new ArgError(message);
}

function parse<T>(decode: () => T): ArgsResult<T> {
  try {
    return { ok: true, args: decode() };
  } catch (error) {
    if (error instanceof ArgError) return { ok: false, message: error.message };
    throw error;
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalid(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

/**
 * Three-state field access matching Effect Schema's `optional`/`NullOr` layering: absent stays
 * `undefined` ("leave the field alone"), and an explicit `null` flows through to the checker,
 * which decides whether "clear it" is a shape the field accepts.
 */
function field(source: Record<string, unknown>, key: string): unknown {
  return source[key];
}

function str(value: unknown, label: string): string {
  if (typeof value !== "string") invalid(`${label} must be a string.`);
  return value;
}

function trimmedNonEmpty(value: unknown, label: string, maxChars: number): string {
  const text = str(value, label);
  if (text.trim() !== text || text.length === 0) {
    invalid(`${label} must be a non-empty trimmed string.`);
  }
  if (text.length > maxChars) invalid(`${label} must be at most ${maxChars} characters.`);
  return text;
}

function bounded(value: unknown, label: string, maxChars: number): string {
  const text = str(value, label);
  if (text.length > maxChars) invalid(`${label} must be at most ${maxChars} characters.`);
  return text;
}

function nonEmptyBounded(value: unknown, label: string, maxChars: number): string {
  const text = bounded(value, label, maxChars);
  if (text.length === 0) invalid(`${label} must not be empty.`);
  return text;
}

function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") invalid(`${label} must be a boolean.`);
  return value;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) invalid(`${label} must be a number.`);
  return value;
}

function literal<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  label: string,
): Values[number] {
  const text = str(value, label);
  if (!values.includes(text)) invalid(`${label} must be one of ${values.join(", ")}.`);
  return text as Values[number];
}

function patterned(value: unknown, pattern: RegExp, label: string, description: string): string {
  const text = trimmedNonEmpty(value, label, 256);
  if (!pattern.test(text)) invalid(`${label} must be ${description}.`);
  return text;
}

function domainId(value: unknown, label: string): string {
  return trimmedNonEmpty(value, label, 128);
}

function nullable<T>(value: unknown, decode: (value: unknown) => T): T | null {
  return value === null ? null : decode(value);
}

function arrayOf<T>(
  value: unknown,
  label: string,
  maxItems: number,
  decode: (item: unknown, itemLabel: string) => T,
): readonly T[] {
  if (!Array.isArray(value)) invalid(`${label} must be an array.`);
  if (value.length > maxItems) invalid(`${label} must hold at most ${maxItems} entries.`);
  return value.map((item, index) => decode(item, `${label}[${index}]`));
}

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

/** `IssueAssignee` from `contracts/issues`: intent, so narrower than the write actor. */
export type IssueAssignee =
  | { readonly kind: "user" }
  | { readonly kind: "member"; readonly membershipId: string }
  | { readonly kind: "agent"; readonly provider: string };

function assignee(value: unknown, label: string): IssueAssignee {
  const source = record(value, label);
  const kind = literal(field(source, "kind"), ["user", "member", "agent"], `${label}.kind`);
  if (kind === "user") return { kind };
  if (kind === "member") {
    return { kind, membershipId: domainId(field(source, "membershipId"), `${label}.membershipId`) };
  }
  return { kind, provider: trimmedNonEmpty(field(source, "provider"), `${label}.provider`, 128) };
}

/** `IssueWorkflowOwner` from `contracts/cloudSync`. */
export type IssueWorkflowOwner =
  | { readonly kind: "company" }
  | { readonly kind: "team"; readonly teamId: string };

function workflowOwner(value: unknown, label: string): IssueWorkflowOwner {
  const source = record(value, label);
  const kind = literal(field(source, "kind"), ["company", "team"], `${label}.kind`);
  if (kind === "company") return { kind };
  return { kind, teamId: domainId(field(source, "teamId"), `${label}.teamId`) };
}

/** Slack source metadata carried only by an environment-authored intake create. */
export interface IssueSlackSource {
  readonly issueId: string;
  readonly channelId: string;
  readonly messageTs: string;
  readonly permalink: string | null;
  readonly authorName: string | null;
}

function slackSource(value: unknown, label: string): IssueSlackSource {
  const source = record(value, label);
  return {
    issueId: domainId(field(source, "issueId"), `${label}.issueId`),
    channelId: trimmedNonEmpty(field(source, "channelId"), `${label}.channelId`, 256),
    messageTs: trimmedNonEmpty(field(source, "messageTs"), `${label}.messageTs`, 256),
    permalink: nullable(field(source, "permalink"), (inner) =>
      trimmedNonEmpty(inner, `${label}.permalink`, 8_192),
    ),
    authorName: nullable(field(source, "authorName"), (inner) =>
      trimmedNonEmpty(inner, `${label}.authorName`, 512),
    ),
  };
}

function issueColor(value: unknown, label: string): string {
  return patterned(value, ISSUE_COLOR_PATTERN, label, "a #rgb or #rrggbb color");
}

function issueDate(value: unknown, label: string): string {
  return patterned(value, ISSUE_DATE_PATTERN, label, "a YYYY-MM-DD date");
}

function issueKey(value: unknown, label: string): string {
  return patterned(value, ISSUE_KEY_PATTERN, label, "an issue key like PAT-42");
}

/** Stored opaque (`v.any()` in the table); only its being an object is checkable here. */
function modelSelection(value: unknown, label: string): unknown {
  record(value, label);
  return value;
}

function labelIds(value: unknown, label: string): readonly string[] {
  return arrayOf(value, label, ISSUE_LABELS_MAX_PER_ISSUE, (item, itemLabel) =>
    domainId(item, itemLabel),
  );
}

function teamIds(value: unknown, label: string): readonly string[] {
  return arrayOf(value, label, 256, (item, itemLabel) => domainId(item, itemLabel));
}

/** `IssueViewConfig` from `contracts/issues`: a saved chip bar, validated chip by chip. */
export interface IssueViewConfig {
  readonly tab: (typeof ISSUE_VIEW_TABS)[number];
  readonly statusIds?: readonly string[] | undefined;
  readonly projectIds?: readonly string[] | undefined;
  readonly labelIds?: readonly string[] | undefined;
  readonly milestoneIds?: readonly string[] | undefined;
  readonly cycleIds?: readonly string[] | undefined;
  readonly assignees?: readonly IssueAssignee[] | undefined;
  readonly priorities?: readonly IssuePriority[] | undefined;
  readonly dueFilter?: (typeof ISSUE_VIEW_DUE_FILTERS)[number] | undefined;
  readonly grouping: (typeof ISSUE_VIEW_GROUPINGS)[number];
  readonly sortMode: (typeof ISSUE_VIEW_SORT_MODES)[number];
  readonly viewMode: (typeof ISSUE_VIEW_MODES)[number];
}

function viewFilterIds(value: unknown, label: string): readonly string[] | undefined {
  if (value === undefined) return undefined;
  return arrayOf(value, label, ISSUE_VIEW_FILTER_MAX_VALUES, (item, itemLabel) =>
    domainId(item, itemLabel),
  );
}

function viewConfig(value: unknown, label: string): IssueViewConfig {
  const source = record(value, label);
  const dueFilter = field(source, "dueFilter");
  const assignees = field(source, "assignees");
  const priorities = field(source, "priorities");
  return {
    tab: literal(field(source, "tab"), ISSUE_VIEW_TABS, `${label}.tab`),
    statusIds: viewFilterIds(field(source, "statusIds"), `${label}.statusIds`),
    projectIds: viewFilterIds(field(source, "projectIds"), `${label}.projectIds`),
    labelIds: viewFilterIds(field(source, "labelIds"), `${label}.labelIds`),
    milestoneIds: viewFilterIds(field(source, "milestoneIds"), `${label}.milestoneIds`),
    cycleIds: viewFilterIds(field(source, "cycleIds"), `${label}.cycleIds`),
    assignees:
      assignees === undefined
        ? undefined
        : arrayOf(
            assignees,
            `${label}.assignees`,
            ISSUE_VIEW_FILTER_MAX_VALUES,
            (item, itemLabel) => assignee(item, itemLabel),
          ),
    priorities:
      priorities === undefined
        ? undefined
        : arrayOf(
            priorities,
            `${label}.priorities`,
            ISSUE_VIEW_FILTER_MAX_VALUES,
            (item, itemLabel) => literal(item, ISSUE_PRIORITIES, itemLabel),
          ),
    dueFilter:
      dueFilter === undefined
        ? undefined
        : literal(dueFilter, ISSUE_VIEW_DUE_FILTERS, `${label}.dueFilter`),
    grouping: literal(field(source, "grouping"), ISSUE_VIEW_GROUPINGS, `${label}.grouping`),
    sortMode: literal(field(source, "sortMode"), ISSUE_VIEW_SORT_MODES, `${label}.sortMode`),
    viewMode: literal(field(source, "viewMode"), ISSUE_VIEW_MODES, `${label}.viewMode`),
  };
}

// ---------------------------------------------------------------------------
// Operation argument parsers
// ---------------------------------------------------------------------------

export interface IssueCreateArgs {
  readonly key?: string | undefined;
  readonly title: string;
  readonly description?: string | undefined;
  readonly statusId?: string | undefined;
  readonly priority?: IssuePriority | undefined;
  readonly assignee?: IssueAssignee | undefined;
  readonly projectId?: string | undefined;
  readonly milestoneId?: string | undefined;
  readonly cycleId?: string | undefined;
  readonly parentId?: string | undefined;
  readonly labelIds?: readonly string[] | undefined;
  readonly dueDate?: string | undefined;
  readonly triage?: boolean | undefined;
  readonly slackSource?: IssueSlackSource | undefined;
  readonly sortOrder?: string | undefined;
  readonly teamIds?: readonly string[] | undefined;
  readonly workflowOwner?: IssueWorkflowOwner | undefined;
  readonly workModelSelection?: unknown | null | undefined;
}

export function parseIssueCreateArgs(value: unknown): ArgsResult<IssueCreateArgs> {
  return parse(() => {
    const source = record(value, "args");
    const optionalString = (key: string, decode: (v: unknown, label: string) => string) => {
      const raw = field(source, key);
      return raw === undefined ? undefined : decode(raw, `args.${key}`);
    };
    const rawAssignee = field(source, "assignee");
    const rawLabelIds = field(source, "labelIds");
    const rawTriage = field(source, "triage");
    const rawSlackSource = field(source, "slackSource");
    const rawTeamIds = field(source, "teamIds");
    const rawOwner = field(source, "workflowOwner");
    const rawSelection = field(source, "workModelSelection");
    return {
      key: optionalString("key", issueKey),
      title: trimmedNonEmpty(field(source, "title"), "args.title", ISSUE_TITLE_MAX_CHARS),
      description: optionalString("description", (v, label) =>
        bounded(v, label, ISSUE_DESCRIPTION_MAX_CHARS),
      ),
      statusId: optionalString("statusId", domainId),
      priority:
        field(source, "priority") === undefined
          ? undefined
          : literal(field(source, "priority"), ISSUE_PRIORITIES, "args.priority"),
      assignee: rawAssignee === undefined ? undefined : assignee(rawAssignee, "args.assignee"),
      projectId: optionalString("projectId", domainId),
      milestoneId: optionalString("milestoneId", domainId),
      cycleId: optionalString("cycleId", domainId),
      parentId: optionalString("parentId", domainId),
      labelIds: rawLabelIds === undefined ? undefined : labelIds(rawLabelIds, "args.labelIds"),
      dueDate: optionalString("dueDate", issueDate),
      triage: rawTriage === undefined ? undefined : bool(rawTriage, "args.triage"),
      slackSource:
        rawSlackSource === undefined ? undefined : slackSource(rawSlackSource, "args.slackSource"),
      sortOrder: optionalString("sortOrder", (v, label) => trimmedNonEmpty(v, label, 256)),
      teamIds: rawTeamIds === undefined ? undefined : teamIds(rawTeamIds, "args.teamIds"),
      workflowOwner:
        rawOwner === undefined ? undefined : workflowOwner(rawOwner, "args.workflowOwner"),
      workModelSelection:
        rawSelection === undefined
          ? undefined
          : nullable(rawSelection, (v) => modelSelection(v, "args.workModelSelection")),
    };
  });
}

export interface IssuePatchArgs {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly statusId?: string | undefined;
  readonly priority?: IssuePriority | undefined;
  readonly assignee?: IssueAssignee | null | undefined;
  readonly workModelSelection?: unknown | null | undefined;
  readonly projectId?: string | null | undefined;
  readonly milestoneId?: string | null | undefined;
  readonly cycleId?: string | null | undefined;
  readonly parentId?: string | null | undefined;
  readonly labelIds?: readonly string[] | undefined;
  readonly dueDate?: string | null | undefined;
  readonly triage?: boolean | undefined;
}

export function parseIssuePatchArgs(value: unknown): ArgsResult<IssuePatchArgs> {
  return parse(() => {
    const source = record(value, "args");
    const opt = <T>(key: string, decode: (v: unknown, label: string) => T): T | undefined => {
      const raw = field(source, key);
      return raw === undefined ? undefined : decode(raw, `args.${key}`);
    };
    return {
      title: opt("title", (v, label) => trimmedNonEmpty(v, label, ISSUE_TITLE_MAX_CHARS)),
      description: opt("description", (v, label) => bounded(v, label, ISSUE_DESCRIPTION_MAX_CHARS)),
      statusId: opt("statusId", domainId),
      priority: opt("priority", (v, label) => literal(v, ISSUE_PRIORITIES, label)),
      assignee: opt("assignee", (v, label) => nullable(v, (inner) => assignee(inner, label))),
      workModelSelection: opt("workModelSelection", (v, label) =>
        nullable(v, (inner) => modelSelection(inner, label)),
      ),
      projectId: opt("projectId", (v, label) => nullable(v, (inner) => domainId(inner, label))),
      milestoneId: opt("milestoneId", (v, label) => nullable(v, (inner) => domainId(inner, label))),
      cycleId: opt("cycleId", (v, label) => nullable(v, (inner) => domainId(inner, label))),
      parentId: opt("parentId", (v, label) => nullable(v, (inner) => domainId(inner, label))),
      labelIds: opt("labelIds", labelIds),
      dueDate: opt("dueDate", (v, label) => nullable(v, (inner) => issueDate(inner, label))),
      triage: opt("triage", bool),
    };
  });
}

export interface IssueSetSortOrderArgs {
  readonly sortOrder: string;
  readonly statusId?: string | undefined;
}

export function parseIssueSetSortOrderArgs(value: unknown): ArgsResult<IssueSetSortOrderArgs> {
  return parse(() => {
    const source = record(value, "args");
    const rawStatus = field(source, "statusId");
    return {
      sortOrder: trimmedNonEmpty(field(source, "sortOrder"), "args.sortOrder", 256),
      statusId: rawStatus === undefined ? undefined : domainId(rawStatus, "args.statusId"),
    };
  });
}

export interface IssueSetWorkflowOwnerArgs {
  readonly workflowOwner: IssueWorkflowOwner;
  readonly statusId?: string | undefined;
}

export function parseIssueSetWorkflowOwnerArgs(
  value: unknown,
): ArgsResult<IssueSetWorkflowOwnerArgs> {
  return parse(() => {
    const source = record(value, "args");
    const rawStatus = field(source, "statusId");
    return {
      workflowOwner: workflowOwner(field(source, "workflowOwner"), "args.workflowOwner"),
      statusId: rawStatus === undefined ? undefined : domainId(rawStatus, "args.statusId"),
    };
  });
}

export interface IssueSetTeamsArgs {
  readonly teamIds: readonly string[];
}

export function parseIssueSetTeamsArgs(value: unknown): ArgsResult<IssueSetTeamsArgs> {
  return parse(() => {
    const source = record(value, "args");
    return { teamIds: teamIds(field(source, "teamIds"), "args.teamIds") };
  });
}

export interface IssueStatusCreateArgs {
  readonly scope: "company" | "team";
  readonly teamId?: string | null | undefined;
  readonly baseStatusId?: string | null | undefined;
  readonly name?: string | undefined;
  readonly color?: string | undefined;
  readonly category?: IssueStatusCategory | undefined;
  readonly position?: number | undefined;
  readonly hidden?: boolean | undefined;
}

export function parseIssueStatusCreateArgs(value: unknown): ArgsResult<IssueStatusCreateArgs> {
  return parse(() => {
    const source = record(value, "args");
    const opt = <T>(key: string, decode: (v: unknown, label: string) => T): T | undefined => {
      const raw = field(source, key);
      return raw === undefined ? undefined : decode(raw, `args.${key}`);
    };
    return {
      scope: literal(field(source, "scope"), ["company", "team"], "args.scope"),
      teamId: opt("teamId", (v, label) => nullable(v, (inner) => domainId(inner, label))),
      baseStatusId: opt("baseStatusId", (v, label) =>
        nullable(v, (inner) => domainId(inner, label)),
      ),
      name: opt("name", (v, label) => trimmedNonEmpty(v, label, ISSUE_TITLE_MAX_CHARS)),
      color: opt("color", issueColor),
      category: opt("category", (v, label) => literal(v, ISSUE_STATUS_CATEGORIES, label)),
      position: opt("position", finiteNumber),
      hidden: opt("hidden", bool),
    };
  });
}

export interface IssueStatusPatchArgs {
  readonly name?: string | null | undefined;
  readonly color?: string | null | undefined;
  readonly category?: IssueStatusCategory | null | undefined;
  readonly position?: number | null | undefined;
  readonly hidden?: boolean | undefined;
}

export function parseIssueStatusPatchArgs(value: unknown): ArgsResult<IssueStatusPatchArgs> {
  return parse(() => {
    const source = record(value, "args");
    const opt = <T>(key: string, decode: (v: unknown, label: string) => T): T | undefined => {
      const raw = field(source, key);
      return raw === undefined ? undefined : decode(raw, `args.${key}`);
    };
    return {
      name: opt("name", (v, label) =>
        nullable(v, (inner) => trimmedNonEmpty(inner, label, ISSUE_TITLE_MAX_CHARS)),
      ),
      color: opt("color", (v, label) => nullable(v, (inner) => issueColor(inner, label))),
      category: opt("category", (v, label) =>
        nullable(v, (inner) => literal(inner, ISSUE_STATUS_CATEGORIES, label)),
      ),
      position: opt("position", (v, label) => nullable(v, (inner) => finiteNumber(inner, label))),
      hidden: opt("hidden", bool),
    };
  });
}

export interface IssueStatusDeleteArgs {
  readonly reassignToStatusId: string;
}

export function parseIssueStatusDeleteArgs(value: unknown): ArgsResult<IssueStatusDeleteArgs> {
  return parse(() => {
    const source = record(value, "args");
    return {
      reassignToStatusId: domainId(field(source, "reassignToStatusId"), "args.reassignToStatusId"),
    };
  });
}

export interface IssueStatusesReorderArgs {
  readonly statusIds: readonly string[];
}

export function parseIssueStatusesReorderArgs(
  value: unknown,
): ArgsResult<IssueStatusesReorderArgs> {
  return parse(() => {
    const source = record(value, "args");
    const ids = arrayOf(field(source, "statusIds"), "args.statusIds", 1024, (item, itemLabel) =>
      domainId(item, itemLabel),
    );
    if (ids.length === 0) invalid("args.statusIds must not be empty.");
    return { statusIds: ids };
  });
}

export interface IssueLabelCreateArgs {
  readonly name: string;
  readonly color: string;
  readonly teamId?: string | null | undefined;
}

export function parseIssueLabelCreateArgs(value: unknown): ArgsResult<IssueLabelCreateArgs> {
  return parse(() => {
    const source = record(value, "args");
    const rawTeam = field(source, "teamId");
    return {
      name: trimmedNonEmpty(field(source, "name"), "args.name", ISSUE_TITLE_MAX_CHARS),
      color: issueColor(field(source, "color"), "args.color"),
      teamId:
        rawTeam === undefined
          ? undefined
          : nullable(rawTeam, (inner) => domainId(inner, "args.teamId")),
    };
  });
}

export interface IssueLabelPatchArgs {
  readonly name?: string | undefined;
  readonly color?: string | undefined;
}

export function parseIssueLabelPatchArgs(value: unknown): ArgsResult<IssueLabelPatchArgs> {
  return parse(() => {
    const source = record(value, "args");
    const rawName = field(source, "name");
    const rawColor = field(source, "color");
    return {
      name:
        rawName === undefined
          ? undefined
          : trimmedNonEmpty(rawName, "args.name", ISSUE_TITLE_MAX_CHARS),
      color: rawColor === undefined ? undefined : issueColor(rawColor, "args.color"),
    };
  });
}

export interface IssueMilestoneCreateArgs {
  readonly cloudProjectId: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly startDate?: string | undefined;
  readonly targetDate?: string | undefined;
  readonly position?: number | undefined;
}

export function parseIssueMilestoneCreateArgs(
  value: unknown,
): ArgsResult<IssueMilestoneCreateArgs> {
  return parse(() => {
    const source = record(value, "args");
    const opt = <T>(key: string, decode: (v: unknown, label: string) => T): T | undefined => {
      const raw = field(source, key);
      return raw === undefined ? undefined : decode(raw, `args.${key}`);
    };
    return {
      cloudProjectId: domainId(field(source, "cloudProjectId"), "args.cloudProjectId"),
      name: trimmedNonEmpty(field(source, "name"), "args.name", ISSUE_TITLE_MAX_CHARS),
      description: opt("description", (v, label) => bounded(v, label, ISSUE_DESCRIPTION_MAX_CHARS)),
      startDate: opt("startDate", issueDate),
      targetDate: opt("targetDate", issueDate),
      position: opt("position", finiteNumber),
    };
  });
}

export interface IssueMilestonePatchArgs {
  readonly name?: string | undefined;
  readonly description?: string | null | undefined;
  readonly startDate?: string | null | undefined;
  readonly targetDate?: string | null | undefined;
  readonly position?: number | undefined;
  readonly cloudProjectId?: string | undefined;
}

export function parseIssueMilestonePatchArgs(value: unknown): ArgsResult<IssueMilestonePatchArgs> {
  return parse(() => {
    const source = record(value, "args");
    const opt = <T>(key: string, decode: (v: unknown, label: string) => T): T | undefined => {
      const raw = field(source, key);
      return raw === undefined ? undefined : decode(raw, `args.${key}`);
    };
    return {
      name: opt("name", (v, label) => trimmedNonEmpty(v, label, ISSUE_TITLE_MAX_CHARS)),
      description: opt("description", (v, label) =>
        nullable(v, (inner) => bounded(inner, label, ISSUE_DESCRIPTION_MAX_CHARS)),
      ),
      startDate: opt("startDate", (v, label) => nullable(v, (inner) => issueDate(inner, label))),
      targetDate: opt("targetDate", (v, label) => nullable(v, (inner) => issueDate(inner, label))),
      position: opt("position", finiteNumber),
      cloudProjectId: opt("cloudProjectId", domainId),
    };
  });
}

export interface IssueCycleCreateArgs {
  readonly name: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly teamId?: string | null | undefined;
}

export function parseIssueCycleCreateArgs(value: unknown): ArgsResult<IssueCycleCreateArgs> {
  return parse(() => {
    const source = record(value, "args");
    const rawTeam = field(source, "teamId");
    const args = {
      name: trimmedNonEmpty(field(source, "name"), "args.name", ISSUE_TITLE_MAX_CHARS),
      startDate: issueDate(field(source, "startDate"), "args.startDate"),
      endDate: issueDate(field(source, "endDate"), "args.endDate"),
      teamId:
        rawTeam === undefined
          ? undefined
          : nullable(rawTeam, (inner) => domainId(inner, "args.teamId")),
    };
    if (args.endDate < args.startDate) invalid("args.endDate must not precede args.startDate.");
    return args;
  });
}

export interface IssueCyclePatchArgs {
  readonly name?: string | undefined;
  readonly startDate?: string | undefined;
  readonly endDate?: string | undefined;
}

export function parseIssueCyclePatchArgs(value: unknown): ArgsResult<IssueCyclePatchArgs> {
  return parse(() => {
    const source = record(value, "args");
    const opt = <T>(key: string, decode: (v: unknown, label: string) => T): T | undefined => {
      const raw = field(source, key);
      return raw === undefined ? undefined : decode(raw, `args.${key}`);
    };
    return {
      name: opt("name", (v, label) => trimmedNonEmpty(v, label, ISSUE_TITLE_MAX_CHARS)),
      startDate: opt("startDate", issueDate),
      endDate: opt("endDate", issueDate),
    };
  });
}

export interface IssueTodoCreateArgs {
  readonly issueId: string;
  readonly text: string;
  readonly sortOrder?: string | undefined;
}

export function parseIssueTodoCreateArgs(value: unknown): ArgsResult<IssueTodoCreateArgs> {
  return parse(() => {
    const source = record(value, "args");
    const rawSort = field(source, "sortOrder");
    return {
      issueId: domainId(field(source, "issueId"), "args.issueId"),
      text: trimmedNonEmpty(field(source, "text"), "args.text", ISSUE_TITLE_MAX_CHARS),
      sortOrder:
        rawSort === undefined ? undefined : trimmedNonEmpty(rawSort, "args.sortOrder", 256),
    };
  });
}

export interface IssueTodoPatchArgs {
  readonly text?: string | undefined;
  readonly done?: boolean | undefined;
  readonly sortOrder?: string | undefined;
}

export function parseIssueTodoPatchArgs(value: unknown): ArgsResult<IssueTodoPatchArgs> {
  return parse(() => {
    const source = record(value, "args");
    const opt = <T>(key: string, decode: (v: unknown, label: string) => T): T | undefined => {
      const raw = field(source, key);
      return raw === undefined ? undefined : decode(raw, `args.${key}`);
    };
    return {
      text: opt("text", (v, label) => trimmedNonEmpty(v, label, ISSUE_TITLE_MAX_CHARS)),
      done: opt("done", bool),
      sortOrder: opt("sortOrder", (v, label) => trimmedNonEmpty(v, label, 256)),
    };
  });
}

export interface IssueRelationCreateArgs {
  readonly issueId: string;
  readonly relatedIssueId: string;
  readonly kind: IssueRelationKind;
}

export function parseIssueRelationCreateArgs(value: unknown): ArgsResult<IssueRelationCreateArgs> {
  return parse(() => {
    const source = record(value, "args");
    const args = {
      issueId: domainId(field(source, "issueId"), "args.issueId"),
      relatedIssueId: domainId(field(source, "relatedIssueId"), "args.relatedIssueId"),
      kind: literal(field(source, "kind"), ISSUE_RELATION_KINDS, "args.kind"),
    };
    if (args.issueId === args.relatedIssueId) invalid("An issue cannot relate to itself.");
    return args;
  });
}

export interface IssueCommentCreateArgs {
  readonly issueId: string;
  readonly body: string;
  readonly attachmentIds?: readonly string[] | undefined;
}

export function parseIssueCommentCreateArgs(value: unknown): ArgsResult<IssueCommentCreateArgs> {
  return parse(() => {
    const source = record(value, "args");
    const rawAttachments = field(source, "attachmentIds");
    return {
      issueId: domainId(field(source, "issueId"), "args.issueId"),
      body: nonEmptyBounded(field(source, "body"), "args.body", ISSUE_COMMENT_MAX_CHARS),
      attachmentIds:
        rawAttachments === undefined
          ? undefined
          : arrayOf(
              rawAttachments,
              "args.attachmentIds",
              ISSUE_COMMENT_MAX_ATTACHMENTS,
              (item, itemLabel) => domainId(item, itemLabel),
            ),
    };
  });
}

export interface IssueCommentPatchArgs {
  readonly body?: string | undefined;
  readonly attachmentIds?: readonly string[] | undefined;
}

export function parseIssueCommentPatchArgs(value: unknown): ArgsResult<IssueCommentPatchArgs> {
  return parse(() => {
    const source = record(value, "args");
    const rawBody = field(source, "body");
    const rawAttachments = field(source, "attachmentIds");
    return {
      body:
        rawBody === undefined
          ? undefined
          : nonEmptyBounded(rawBody, "args.body", ISSUE_COMMENT_MAX_CHARS),
      attachmentIds:
        rawAttachments === undefined
          ? undefined
          : arrayOf(
              rawAttachments,
              "args.attachmentIds",
              ISSUE_COMMENT_MAX_ATTACHMENTS,
              (item, itemLabel) => domainId(item, itemLabel),
            ),
    };
  });
}

export interface IssueViewCreateArgs {
  readonly name: string;
  readonly config: IssueViewConfig;
  readonly visibility?: IssueViewVisibility | undefined;
  readonly teamIds?: readonly string[] | undefined;
  readonly position?: number | undefined;
}

export function parseIssueViewCreateArgs(value: unknown): ArgsResult<IssueViewCreateArgs> {
  return parse(() => {
    const source = record(value, "args");
    const rawVisibility = field(source, "visibility");
    const rawTeamIds = field(source, "teamIds");
    const rawPosition = field(source, "position");
    return {
      name: trimmedNonEmpty(field(source, "name"), "args.name", ISSUE_TITLE_MAX_CHARS),
      config: viewConfig(field(source, "config"), "args.config"),
      visibility:
        rawVisibility === undefined
          ? undefined
          : literal(rawVisibility, ISSUE_VIEW_VISIBILITIES, "args.visibility"),
      teamIds: rawTeamIds === undefined ? undefined : teamIds(rawTeamIds, "args.teamIds"),
      position: rawPosition === undefined ? undefined : finiteNumber(rawPosition, "args.position"),
    };
  });
}

export interface IssueViewPatchArgs {
  readonly name?: string | undefined;
  readonly config?: IssueViewConfig | undefined;
  readonly visibility?: IssueViewVisibility | undefined;
  readonly teamIds?: readonly string[] | undefined;
  readonly position?: number | undefined;
}

export function parseIssueViewPatchArgs(value: unknown): ArgsResult<IssueViewPatchArgs> {
  return parse(() => {
    const source = record(value, "args");
    const opt = <T>(key: string, decode: (v: unknown, label: string) => T): T | undefined => {
      const raw = field(source, key);
      return raw === undefined ? undefined : decode(raw, `args.${key}`);
    };
    return {
      name: opt("name", (v, label) => trimmedNonEmpty(v, label, ISSUE_TITLE_MAX_CHARS)),
      config: opt("config", viewConfig),
      visibility: opt("visibility", (v, label) => literal(v, ISSUE_VIEW_VISIBILITIES, label)),
      teamIds: opt("teamIds", teamIds),
      position: opt("position", finiteNumber),
    };
  });
}

export interface IssueThreadLinkCreateArgs {
  readonly issueId: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly origin: IssueThreadLinkOrigin;
}

export function parseIssueThreadLinkCreateArgs(
  value: unknown,
): ArgsResult<IssueThreadLinkCreateArgs> {
  return parse(() => {
    const source = record(value, "args");
    return {
      issueId: domainId(field(source, "issueId"), "args.issueId"),
      environmentId: trimmedNonEmpty(field(source, "environmentId"), "args.environmentId", 256),
      threadId: trimmedNonEmpty(field(source, "threadId"), "args.threadId", 256),
      origin: literal(field(source, "origin"), ISSUE_THREAD_LINK_ORIGINS, "args.origin"),
    };
  });
}

/**
 * Entity-only operations — deletes, restores — carry no arguments: the envelope's `entityId`
 * already names the row. `{}` is what a well-formed client sends; `null`/`undefined` are accepted
 * because an empty payload has no wrong reading, and anything with content is refused so a client
 * that meant to send arguments hears about it.
 */
export function parseNoArgs(value: unknown): ArgsResult<Record<string, never>> {
  return parse(() => {
    if (value === undefined || value === null) return {};
    const source = record(value, "args");
    if (Object.keys(source).length > 0) invalid("This operation carries no arguments.");
    return {};
  });
}

// ---------------------------------------------------------------------------
// Derived identifiers and ordering
// ---------------------------------------------------------------------------

/** FNV-1a over UTF-16 code units; the same construction `smokeSeed` uses. */
function fnv1a32(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const hex8 = (value: number): string => value.toString(16).padStart(8, "0");

/**
 * Deterministic UUIDv7-shaped domain id for a server-authored row — an audit event has no client
 * to generate its id, and deriving it from the operation keeps a replayed transaction convergent.
 * Version nibble `7` and variant nibble `8` keep the id shaped like every client-minted one.
 */
export function derivedDomainId(seed: string): string {
  const h1 = hex8(fnv1a32(seed));
  const h2 = hex8(fnv1a32(`${seed}#2`));
  const h3 = hex8(fnv1a32(`${seed}#3`));
  const h4 = hex8(fnv1a32(`${seed}#4`));
  return `${h1}-${h2.slice(0, 4)}-7${h2.slice(4, 7)}-8${h3.slice(0, 3)}-${h3.slice(3, 7)}${h4}`;
}

/** The id of the `n`th audit event one operation produced. */
export function auditEventDomainId(operationId: string, index: number): string {
  return derivedDomainId(`${operationId}:audit:${index}`);
}

/**
 * Default sort key for a new issue: zero-padded key number, so unordered issues read in creation
 * order and any client-supplied fractional key can still land between two of them.
 */
export function defaultIssueSortOrder(keyNumber: number): string {
  return `i${String(Math.max(0, Math.trunc(keyNumber))).padStart(10, "0")}`;
}

/**
 * A key strictly after `last`, for append-at-the-end defaults. Appending any character to a string
 * sorts after it, so the result is minimal-effort but always correctly placed.
 */
export function orderKeyAfter(last: string | null): string {
  return last === null ? "a0" : `${last}V`;
}

/** The numeric half of an issue key: `PAT-42` → 42. The caller validated the shape. */
export function issueKeyNumber(key: string): number {
  return Number.parseInt(key.slice(key.lastIndexOf("-") + 1), 10);
}
