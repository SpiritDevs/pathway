/**
 * RFC 4180 CSV reader and header mapping for the issue importer.
 *
 * Hand-rolled rather than a dependency: one import path reads one exported file, and the
 * tolerance this needs — report a broken row by its line number and keep going — is the opposite
 * of what a parser library does when it meets one.
 *
 * Shared rather than server-local because the settings page previews a file before uploading it.
 * A preview that counted rows or recognised columns by its own rules would disagree with the
 * import it is previewing the moment either side changed.
 *
 * @module issuesCsv
 */

/** One CSV record. A quoted field may hold newlines, so a record is not a line. */
export interface CsvRecord {
  /** 1-based physical line the record starts on, which is what a skip report has to name. */
  readonly line: number;
  readonly fields: ReadonlyArray<string>;
  /** A quote that never closed, or text after a closing quote. The row is reported, not trusted. */
  readonly malformed: boolean;
}

const BYTE_ORDER_MARK = 0xfeff;

/**
 * Split CSV text into records. Blank lines are dropped rather than reported: an export that ends
 * with a newline is not a broken row.
 */
export function parseCsv(text: string): ReadonlyArray<CsvRecord> {
  const source = text.charCodeAt(0) === BYTE_ORDER_MARK ? text.slice(1) : text;
  const records: Array<CsvRecord> = [];
  let fields: Array<string> = [];
  let field = "";
  let line = 1;
  let recordLine = 1;
  let malformed = false;
  let index = 0;

  const endRecord = () => {
    fields.push(field);
    const isBlankLine = fields.length === 1 && fields[0] === "" && !malformed;
    if (!isBlankLine) {
      records.push({ line: recordLine, fields, malformed });
    }
    fields = [];
    field = "";
    malformed = false;
  };

  while (index < source.length) {
    const char = source[index];

    if (char === '"') {
      index += 1;
      for (;;) {
        if (index >= source.length) {
          malformed = true;
          break;
        }
        const quoted = source[index];
        if (quoted === '"') {
          if (source[index + 1] === '"') {
            field += '"';
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        if (quoted === "\n") line += 1;
        field += quoted;
        index += 1;
      }
      const next = source[index];
      if (next !== undefined && next !== "," && next !== "\r" && next !== "\n") {
        malformed = true;
      }
      continue;
    }

    if (char === ",") {
      fields.push(field);
      field = "";
      index += 1;
      continue;
    }

    if (char === "\r" || char === "\n") {
      if (char === "\r" && source[index + 1] === "\n") index += 1;
      index += 1;
      line += 1;
      endRecord();
      recordLine = line;
      continue;
    }

    field += char;
    index += 1;
  }

  if (field !== "" || fields.length > 0 || malformed) {
    endRecord();
  }

  return records;
}

/**
 * Header aliases, matched case- and space-insensitively. Linear's own export uses the first name
 * in each list; the rest are what hand-made files and other trackers call the same column.
 */
export const ISSUE_CSV_COLUMN_ALIASES = {
  key: ["id", "key", "identifier", "issue id", "issue key"],
  title: ["title", "name", "summary"],
  description: ["description", "body", "details"],
  status: ["status", "state"],
  priority: ["priority"],
  labels: ["labels", "label", "tags"],
  created: ["created", "created at", "createdat", "created date"],
  updated: ["updated", "updated at", "updatedat", "updated date"],
  dueDate: ["due date", "duedate", "due"],
  parent: ["parent issue", "parent", "parent id", "parent key"],
} as const satisfies Record<string, ReadonlyArray<string>>;

export type IssueCsvColumnName = keyof typeof ISSUE_CSV_COLUMN_ALIASES;

export function normalizeIssueCsvHeader(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/gu, " ");
}

/** Which column each recognised field sits in. An unrecognised header simply has no entry. */
export function resolveIssueCsvColumns(
  header: ReadonlyArray<string>,
): Partial<Record<IssueCsvColumnName, number>> {
  const normalized = header.map(normalizeIssueCsvHeader);
  const columns: Partial<Record<IssueCsvColumnName, number>> = {};
  for (const [column, aliases] of Object.entries(ISSUE_CSV_COLUMN_ALIASES) as ReadonlyArray<
    readonly [IssueCsvColumnName, ReadonlyArray<string>]
  >) {
    const index = normalized.findIndex((cell) => aliases.includes(cell as never));
    // First match wins, so `Parent issue` never steals the column `ID` already claimed.
    if (index >= 0 && !Object.values(columns).includes(index)) columns[column] = index;
  }
  return columns;
}

export interface IssueCsvPreviewColumn {
  /** The header cell exactly as the file spells it. */
  readonly header: string;
  /** The field it maps onto, or null when the importer will ignore the column. */
  readonly column: IssueCsvColumnName | null;
}

/**
 * What a file would import, read without importing it.
 *
 * `rowCount` counts data records, malformed ones included: they are rows the file has, and the
 * import reports each by line rather than dropping it silently. A file the importer would refuse
 * outright — no records, or no title column — comes back with `error` set, which is the same
 * refusal `planIssueCsvImport` produces on the server.
 */
export interface IssueCsvPreview {
  readonly rowCount: number;
  readonly columns: ReadonlyArray<IssueCsvPreviewColumn>;
  readonly error: string | null;
}

export function previewIssueCsv(csvText: string): IssueCsvPreview {
  const records = parseCsv(csvText);
  const header = records[0];
  if (header === undefined) {
    return { rowCount: 0, columns: [], error: "The file has no rows." };
  }

  const resolved = resolveIssueCsvColumns(header.fields);
  const columnByIndex = new Map(
    Object.entries(resolved).map(
      ([column, index]) => [index, column as IssueCsvColumnName] as const,
    ),
  );
  const columns = header.fields.map(
    (cell, index): IssueCsvPreviewColumn => ({
      header: cell,
      column: columnByIndex.get(index) ?? null,
    }),
  );

  return {
    rowCount: records.length - 1,
    columns,
    error: resolved.title === undefined ? "No Title column in the header row." : null,
  };
}
