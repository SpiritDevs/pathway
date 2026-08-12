import { IssueActor, IssueEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  IssueEventRepository,
  type IssueEventRepositoryShape,
  ListIssueEventsInput,
} from "../Services/IssueEvents.ts";

const IssueEventDbRow = IssueEvent.mapFields(
  Struct.assign({
    actor: Schema.fromJsonString(IssueActor),
  }),
);

const makeIssueEventRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const appendIssueEventRow = SqlSchema.void({
    Request: IssueEvent,
    execute: (row) =>
      sql`
        INSERT INTO issue_events (
          id,
          issue_id,
          actor_json,
          kind,
          field,
          before,
          after,
          created_at
        )
        VALUES (
          ${row.id},
          ${row.issueId},
          ${JSON.stringify(row.actor)},
          ${row.kind},
          ${row.field},
          ${row.before},
          ${row.after},
          ${row.createdAt}
        )
      `,
  });

  // One edit that moves three fields writes three rows on the same timestamp, so the tiebreak has
  // to be insertion order. A random id would order the feed randomly; rowid is the write order,
  // and this table is append-only so it never moves.
  const listIssueEventRowsByIssue = SqlSchema.findAll({
    Request: ListIssueEventsInput,
    Result: IssueEventDbRow,
    execute: ({ issueId }) =>
      sql`
        SELECT
          id,
          issue_id AS "issueId",
          actor_json AS "actor",
          kind,
          field,
          before,
          after,
          created_at AS "createdAt"
        FROM issue_events
        WHERE issue_id = ${issueId}
        ORDER BY created_at ASC, rowid ASC
      `,
  });

  const append: IssueEventRepositoryShape["append"] = (row) =>
    appendIssueEventRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueEventRepository.append:query",
          "IssueEventRepository.append:encodeRequest",
        ),
      ),
    );

  const appendMany: IssueEventRepositoryShape["appendMany"] = (rows) =>
    sql
      .withTransaction(Effect.forEach(rows, appendIssueEventRow, { discard: true }))
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "IssueEventRepository.appendMany:query",
            "IssueEventRepository.appendMany:encodeRequest",
          ),
        ),
      );

  const listByIssue: IssueEventRepositoryShape["listByIssue"] = (input) =>
    listIssueEventRowsByIssue(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueEventRepository.listByIssue:query",
          "IssueEventRepository.listByIssue:decodeRows",
        ),
      ),
    );

  return {
    append,
    appendMany,
    listByIssue,
  } satisfies IssueEventRepositoryShape;
});

export const IssueEventRepositoryLive = Layer.effect(
  IssueEventRepository,
  makeIssueEventRepository,
);
