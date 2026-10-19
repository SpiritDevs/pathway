/**
 * Linear CSV export → issue rows, as a pure plan the service then writes.
 *
 * Everything here is decoding: no enrichment runs on import (decision 0006), and a row the
 * mapping cannot make sense of is skipped and reported by line rather than taking the other two
 * hundred down with it.
 *
 * @module issues/csvImport
 */
import {
  ISSUE_DESCRIPTION_MAX_CHARS,
  ISSUE_LABELS_MAX_PER_ISSUE,
  ISSUE_TITLE_MAX_CHARS,
  type IssuePriority,
  type IssueStatusCategory,
  type IssuesImportCsvSkip,
} from "@spiritdevs/contracts";
import {
  normalizeIssueCsvHeader,
  parseCsv,
  resolveIssueCsvColumns,
} from "@spiritdevs/shared/issuesCsv";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/** One CSV row that survived decoding. Names, not ids: the service resolves those. */
export interface PlannedIssueImportRow {
  readonly line: number;
  /** The exported key, when the file carried one that reads as a key. */
  readonly key: string | null;
  readonly title: string;
  readonly description: string;
  readonly statusName: string | null;
  readonly priority: IssuePriority;
  readonly labelNames: ReadonlyArray<string>;
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly dueDate: string | null;
  readonly parentKey: string | null;
}

export interface IssueImportPlan {
  readonly rows: ReadonlyArray<PlannedIssueImportRow>;
  readonly skipped: ReadonlyArray<IssuesImportCsvSkip>;
}

const KEY_PATTERN = /^[A-Z][A-Z0-9]*-\d+$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}/;

/**
 * The exported category, guessed from the status name. Linear's export carries the status name
 * but not its category, and the category is what drives every tab and rollup — so a wrong guess
 * is visible and fixable in settings, while no guess would put the whole import in one column.
 */
export function guessIssueStatusCategory(name: string): IssueStatusCategory {
  const normalized = normalizeIssueCsvHeader(name);
  if (normalized.includes("backlog") || normalized.includes("icebox")) return "backlog";
  if (
    normalized.includes("cancel") ||
    normalized.includes("duplicate") ||
    normalized.includes("wont") ||
    normalized.includes("won't")
  ) {
    return "canceled";
  }
  if (
    normalized.includes("done") ||
    normalized.includes("complete") ||
    normalized.includes("closed") ||
    normalized.includes("shipped") ||
    normalized.includes("merged")
  ) {
    return "completed";
  }
  if (
    normalized.includes("review") ||
    normalized.includes("qa") ||
    normalized.includes("verification") ||
    normalized.includes("checking")
  ) {
    return "review";
  }
  if (
    normalized.includes("progress") ||
    normalized.includes("started") ||
    normalized.includes("doing") ||
    normalized.includes("building")
  ) {
    return "started";
  }
  // Everything else — "Todo", "Triage", a name nobody here has seen — is work not yet begun.
  return "unstarted";
}

const NUMERIC_PRIORITIES: ReadonlyArray<IssuePriority> = [
  "none",
  "urgent",
  "high",
  "medium",
  "low",
];

function parsePriority(value: string): IssuePriority {
  const normalized = normalizeIssueCsvHeader(value);
  if (normalized === "") return "none";
  if (/^\d+$/u.test(normalized)) return NUMERIC_PRIORITIES[Number(normalized)] ?? "none";
  if (normalized.includes("urgent") || normalized.includes("critical")) return "urgent";
  if (normalized.includes("high")) return "high";
  if (normalized.includes("medium") || normalized.includes("normal")) return "medium";
  if (normalized.includes("low")) return "low";
  return "none";
}

/** Timestamps land as ISO instants; anything the platform cannot read is left to the caller. */
function parseTimestamp(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  return Option.match(DateTime.make(trimmed), {
    onNone: () => null,
    onSome: DateTime.formatIso,
  });
}

/** A due date is a calendar day, so only the day part of whatever was exported survives. */
function parseDueDate(value: string): string | null {
  const trimmed = value.trim();
  const matched = DATE_PATTERN.exec(trimmed);
  return matched === null ? null : trimmed.slice(0, 10);
}

function parseLabels(value: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  const names: Array<string> = [];
  for (const raw of value.split(",")) {
    const name = raw.trim();
    if (name === "") continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
    if (names.length === ISSUE_LABELS_MAX_PER_ISSUE) break;
  }
  return names;
}

const cell = (fields: ReadonlyArray<string>, index: number | undefined): string =>
  index === undefined ? "" : (fields[index] ?? "");

/**
 * Decode a whole export. A file with no `Title` column produces no rows and one skip naming the
 * header, because the alternative is two hundred identical per-row skips.
 */
export function planIssueCsvImport(csvText: string): IssueImportPlan {
  const records = parseCsv(csvText);
  const header = records[0];
  if (header === undefined) {
    return { rows: [], skipped: [{ line: 1, reason: "The file has no rows." }] };
  }

  const columns = resolveIssueCsvColumns(header.fields);
  if (columns.title === undefined) {
    return {
      rows: [],
      skipped: [
        {
          line: header.line,
          reason: "No Title column in the header row.",
        },
      ],
    };
  }

  const rows: Array<PlannedIssueImportRow> = [];
  const skipped: Array<IssuesImportCsvSkip> = [];
  const keysSeen = new Set<string>();

  for (const record of records.slice(1)) {
    if (record.malformed) {
      skipped.push({ line: record.line, reason: "Unbalanced quotes." });
      continue;
    }
    if (record.fields.length !== header.fields.length) {
      skipped.push({
        line: record.line,
        reason: `Expected ${header.fields.length} columns, found ${record.fields.length}.`,
      });
      continue;
    }

    const title = cell(record.fields, columns.title).trim();
    if (title === "") {
      skipped.push({ line: record.line, reason: "Missing title." });
      continue;
    }
    if (title.length > ISSUE_TITLE_MAX_CHARS) {
      skipped.push({
        line: record.line,
        reason: `Title is longer than ${ISSUE_TITLE_MAX_CHARS} characters.`,
      });
      continue;
    }

    // An unreadable key is not a broken row: the import allocates a fresh one instead.
    const exportedKey = cell(record.fields, columns.key).trim().toUpperCase();
    const key = KEY_PATTERN.test(exportedKey) ? exportedKey : null;
    if (key !== null) {
      if (keysSeen.has(key)) {
        skipped.push({ line: record.line, reason: `Duplicate key ${key} in this file.` });
        continue;
      }
      keysSeen.add(key);
    }

    const statusName = cell(record.fields, columns.status).trim();
    const parentKey = cell(record.fields, columns.parent).trim().toUpperCase();

    rows.push({
      line: record.line,
      key,
      title,
      // Truncated rather than skipped: losing the tail of one body beats losing the issue.
      description: cell(record.fields, columns.description).slice(0, ISSUE_DESCRIPTION_MAX_CHARS),
      statusName: statusName === "" ? null : statusName,
      priority: parsePriority(cell(record.fields, columns.priority)),
      labelNames: parseLabels(cell(record.fields, columns.labels)),
      createdAt: parseTimestamp(cell(record.fields, columns.created)),
      updatedAt: parseTimestamp(cell(record.fields, columns.updated)),
      dueDate: parseDueDate(cell(record.fields, columns.dueDate)),
      parentKey: KEY_PATTERN.test(parentKey) ? parentKey : null,
    });
  }

  return { rows, skipped };
}

/** The prefix an import wants to adopt: the one the first keyed row carried. */
export function importedKeyPrefix(rows: ReadonlyArray<PlannedIssueImportRow>): string | null {
  for (const row of rows) {
    if (row.key !== null) return row.key.slice(0, row.key.lastIndexOf("-"));
  }
  return null;
}

/** The highest number any preserved key used, so the counter can be moved past all of them. */
export function importedMaxKeyNumber(rows: ReadonlyArray<PlannedIssueImportRow>): number {
  let highest = 0;
  for (const row of rows) {
    if (row.key === null) continue;
    const number = Number(row.key.slice(row.key.lastIndexOf("-") + 1));
    if (Number.isSafeInteger(number) && number > highest) highest = number;
  }
  return highest;
}
