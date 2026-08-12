import { IssueLabel, IssueLabelId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  DeleteIssueLabelInput,
  GetIssueLabelInput,
  IssueLabelAssignment,
  IssueLabelRepository,
  type IssueLabelRepositoryShape,
  ListIssueLabelAssignmentsInput,
  SetIssueLabelAssignmentsInput,
} from "../Services/IssueLabels.ts";

const IssueLabelIdRow = Schema.Struct({ labelId: IssueLabelId });

const makeIssueLabelRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertIssueLabelRow = SqlSchema.void({
    Request: IssueLabel,
    execute: (row) =>
      sql`
        INSERT INTO issue_labels (
          id,
          name,
          color,
          created_at
        )
        VALUES (
          ${row.id},
          ${row.name},
          ${row.color},
          ${row.createdAt}
        )
        ON CONFLICT (id)
        DO UPDATE SET
          name = excluded.name,
          color = excluded.color,
          created_at = excluded.created_at
      `,
  });

  const listIssueLabelRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: IssueLabel,
    execute: () =>
      sql`
        SELECT
          id,
          name,
          color,
          created_at AS "createdAt"
        FROM issue_labels
        ORDER BY created_at ASC, id ASC
      `,
  });

  const getIssueLabelRow = SqlSchema.findOneOption({
    Request: GetIssueLabelInput,
    Result: IssueLabel,
    execute: ({ labelId }) =>
      sql`
        SELECT
          id,
          name,
          color,
          created_at AS "createdAt"
        FROM issue_labels
        WHERE id = ${labelId}
      `,
  });

  const deleteIssueLabelRow = SqlSchema.void({
    Request: DeleteIssueLabelInput,
    execute: ({ labelId }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM issue_label_assignments
            WHERE label_id = ${labelId}
          `;
          yield* sql`
            DELETE FROM issue_labels
            WHERE id = ${labelId}
          `;
        }),
      ),
  });

  const listIssueLabelAssignmentRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: IssueLabelAssignment,
    execute: () =>
      sql`
        SELECT
          issue_id AS "issueId",
          label_id AS "labelId"
        FROM issue_label_assignments
        ORDER BY issue_id ASC, label_id ASC
      `,
  });

  const listIssueLabelAssignmentRowsByIssue = SqlSchema.findAll({
    Request: ListIssueLabelAssignmentsInput,
    Result: IssueLabelIdRow,
    execute: ({ issueId }) =>
      sql`
        SELECT label_id AS "labelId"
        FROM issue_label_assignments
        WHERE issue_id = ${issueId}
        ORDER BY label_id ASC
      `,
  });

  const setIssueLabelAssignmentRows = SqlSchema.void({
    Request: SetIssueLabelAssignmentsInput,
    execute: ({ issueId, labelIds }) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`
            DELETE FROM issue_label_assignments
            WHERE issue_id = ${issueId}
          `;
          yield* Effect.forEach(
            labelIds,
            (labelId) =>
              sql`
                INSERT OR IGNORE INTO issue_label_assignments (issue_id, label_id)
                VALUES (${issueId}, ${labelId})
              `,
            { discard: true },
          );
        }),
      ),
  });

  const listAll: IssueLabelRepositoryShape["listAll"] = () =>
    listIssueLabelRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueLabelRepository.listAll:query",
          "IssueLabelRepository.listAll:decodeRows",
        ),
      ),
    );

  const getById: IssueLabelRepositoryShape["getById"] = (input) =>
    getIssueLabelRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueLabelRepository.getById:query",
          "IssueLabelRepository.getById:decodeRow",
        ),
      ),
    );

  const upsert: IssueLabelRepositoryShape["upsert"] = (row) =>
    upsertIssueLabelRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueLabelRepository.upsert:query",
          "IssueLabelRepository.upsert:encodeRequest",
        ),
      ),
    );

  const deleteById: IssueLabelRepositoryShape["deleteById"] = (input) =>
    deleteIssueLabelRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueLabelRepository.deleteById:query",
          "IssueLabelRepository.deleteById:encodeRequest",
        ),
      ),
    );

  const listAssignments: IssueLabelRepositoryShape["listAssignments"] = () =>
    listIssueLabelAssignmentRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueLabelRepository.listAssignments:query",
          "IssueLabelRepository.listAssignments:decodeRows",
        ),
      ),
    );

  const listAssignmentsByIssue: IssueLabelRepositoryShape["listAssignmentsByIssue"] = (input) =>
    listIssueLabelAssignmentRowsByIssue(input).pipe(
      Effect.map((rows) => rows.map((row) => row.labelId)),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueLabelRepository.listAssignmentsByIssue:query",
          "IssueLabelRepository.listAssignmentsByIssue:decodeRows",
        ),
      ),
    );

  const setAssignments: IssueLabelRepositoryShape["setAssignments"] = (input) =>
    setIssueLabelAssignmentRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueLabelRepository.setAssignments:query",
          "IssueLabelRepository.setAssignments:encodeRequest",
        ),
      ),
    );

  return {
    listAll,
    getById,
    upsert,
    deleteById,
    listAssignments,
    listAssignmentsByIssue,
    setAssignments,
  } satisfies IssueLabelRepositoryShape;
});

export const IssueLabelRepositoryLive = Layer.effect(
  IssueLabelRepository,
  makeIssueLabelRepository,
);
