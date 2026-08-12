import { assert, describe, it } from "@effect/vitest";

import { parseCsv, previewIssueCsv } from "./issuesCsv.ts";

describe("parseCsv", () => {
  it("reads plain records and drops the trailing blank line", () => {
    assert.deepStrictEqual(parseCsv("a,b,c\n1,2,3\n"), [
      { line: 1, fields: ["a", "b", "c"], malformed: false },
      { line: 2, fields: ["1", "2", "3"], malformed: false },
    ]);
  });

  it("reads a record that has no trailing newline", () => {
    assert.deepStrictEqual(parseCsv("a,b"), [{ line: 1, fields: ["a", "b"], malformed: false }]);
  });

  it("keeps empty fields, including a trailing one", () => {
    assert.deepStrictEqual(parseCsv(",a,"), [{ line: 1, fields: ["", "a", ""], malformed: false }]);
  });

  it("unescapes quotes and keeps delimiters inside them", () => {
    assert.deepStrictEqual(parseCsv('"a,b","say ""hi""",c'), [
      { line: 1, fields: ["a,b", 'say "hi"', "c"], malformed: false },
    ]);
  });

  it("counts a quoted newline against the next record's line number", () => {
    assert.deepStrictEqual(parseCsv('"one\ntwo",x\nlast,y\n'), [
      { line: 1, fields: ["one\ntwo", "x"], malformed: false },
      { line: 3, fields: ["last", "y"], malformed: false },
    ]);
  });

  it("handles CRLF the same as LF and strips a byte order mark", () => {
    assert.deepStrictEqual(parseCsv("﻿a,b\r\nc,d\r\n"), [
      { line: 1, fields: ["a", "b"], malformed: false },
      { line: 2, fields: ["c", "d"], malformed: false },
    ]);
  });

  it("skips blank lines between records without renumbering the rest", () => {
    assert.deepStrictEqual(parseCsv("a\n\n\nb\n"), [
      { line: 1, fields: ["a"], malformed: false },
      { line: 4, fields: ["b"], malformed: false },
    ]);
  });

  it("flags a quote that never closes", () => {
    assert.deepStrictEqual(parseCsv('a,"unterminated\n'), [
      { line: 1, fields: ["a", "unterminated\n"], malformed: true },
    ]);
  });

  it("flags text after a closing quote and reports the row anyway", () => {
    assert.deepStrictEqual(parseCsv('"quoted"junk,b\nok,c\n'), [
      { line: 1, fields: ["quotedjunk", "b"], malformed: true },
      { line: 2, fields: ["ok", "c"], malformed: false },
    ]);
  });

  it("returns nothing for empty and whitespace-only input", () => {
    assert.deepStrictEqual(parseCsv(""), []);
    assert.deepStrictEqual(parseCsv("\n\n"), []);
  });
});

describe("previewIssueCsv", () => {
  it("counts data rows and names the field behind each header", () => {
    const preview = previewIssueCsv(
      [
        "ID,Title,Description,Status,Team",
        'PAT-1,First,"Two\nlines",Todo,Pathway',
        "PAT-2,Second,,Done,Pathway",
        "",
      ].join("\n"),
    );

    // A quoted newline is one row, not two.
    assert.strictEqual(preview.rowCount, 2);
    assert.strictEqual(preview.error, null);
    assert.deepStrictEqual(preview.columns, [
      { header: "ID", column: "key" },
      { header: "Title", column: "title" },
      { header: "Description", column: "description" },
      { header: "Status", column: "status" },
      // Linear exports a Team column the tracker has no field for.
      { header: "Team", column: null },
    ]);
  });

  it("counts a malformed row, because the import reports it rather than dropping it", () => {
    const preview = previewIssueCsv('Title\nFine\n"unterminated\n');
    assert.strictEqual(preview.rowCount, 2);
  });

  it("reports the refusals the importer would make", () => {
    assert.strictEqual(previewIssueCsv("").error, "The file has no rows.");
    assert.strictEqual(
      previewIssueCsv("Identifier,Status\nPAT-1,Todo\n").error,
      "No Title column in the header row.",
    );
  });
});
