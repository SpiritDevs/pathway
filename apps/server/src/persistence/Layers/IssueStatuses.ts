import { IssueStatus } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  DeleteIssueStatusInput,
  GetIssueStatusInput,
  IssueStatusRepository,
  type IssueStatusRepositoryShape,
  SetIssueStatusPositionsInput,
} from "../Services/IssueStatuses.ts";

const makeIssueStatusRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertIssueStatusRow = SqlSchema.void({
    Request: IssueStatus,
    execute: (row) =>
      sql`
        INSERT INTO issue_statuses (
          id,
          name,
          color,
          category,
          position,
          created_at,
          updated_at
        )
        VALUES (
          ${row.id},
          ${row.name},
          ${row.color},
          ${row.category},
          ${row.position},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (id)
        DO UPDATE SET
          name = excluded.name,
          color = excluded.color,
          category = excluded.category,
          position = excluded.position,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
  });

  const listIssueStatusRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: IssueStatus,
    execute: () =>
      sql`
        SELECT
          id,
          name,
          color,
          category,
          position,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM issue_statuses
        ORDER BY position ASC, id ASC
      `,
  });

  const getIssueStatusRow = SqlSchema.findOneOption({
    Request: GetIssueStatusInput,
    Result: IssueStatus,
    execute: ({ statusId }) =>
      sql`
        SELECT
          id,
          name,
          color,
          category,
          position,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM issue_statuses
        WHERE id = ${statusId}
      `,
  });

  const deleteIssueStatusRow = SqlSchema.void({
    Request: DeleteIssueStatusInput,
    execute: ({ statusId }) =>
      sql`
        DELETE FROM issue_statuses
        WHERE id = ${statusId}
      `,
  });

  const setIssueStatusPositionRows = SqlSchema.void({
    Request: SetIssueStatusPositionsInput,
    execute: ({ positions, updatedAt }) =>
      sql.withTransaction(
        Effect.forEach(
          positions,
          ({ statusId, position }) =>
            sql`
              UPDATE issue_statuses
              SET position = ${position},
                  updated_at = ${updatedAt}
              WHERE id = ${statusId}
            `,
          { discard: true },
        ),
      ),
  });

  const listAll: IssueStatusRepositoryShape["listAll"] = () =>
    listIssueStatusRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueStatusRepository.listAll:query",
          "IssueStatusRepository.listAll:decodeRows",
        ),
      ),
    );

  const getById: IssueStatusRepositoryShape["getById"] = (input) =>
    getIssueStatusRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueStatusRepository.getById:query",
          "IssueStatusRepository.getById:decodeRow",
        ),
      ),
    );

  const upsert: IssueStatusRepositoryShape["upsert"] = (row) =>
    upsertIssueStatusRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueStatusRepository.upsert:query",
          "IssueStatusRepository.upsert:encodeRequest",
        ),
      ),
    );

  const deleteById: IssueStatusRepositoryShape["deleteById"] = (input) =>
    deleteIssueStatusRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueStatusRepository.deleteById:query",
          "IssueStatusRepository.deleteById:encodeRequest",
        ),
      ),
    );

  const setPositions: IssueStatusRepositoryShape["setPositions"] = (input) =>
    setIssueStatusPositionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueStatusRepository.setPositions:query",
          "IssueStatusRepository.setPositions:encodeRequest",
        ),
      ),
    );

  return {
    listAll,
    getById,
    upsert,
    deleteById,
    setPositions,
  } satisfies IssueStatusRepositoryShape;
});

export const IssueStatusRepositoryLive = Layer.effect(
  IssueStatusRepository,
  makeIssueStatusRepository,
);
