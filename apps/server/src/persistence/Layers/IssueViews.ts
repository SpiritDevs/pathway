import { IssueView, IssueViewConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  DeleteIssueViewInput,
  GetIssueViewInput,
  IssueViewRepository,
  type IssueViewRepositoryShape,
  SetIssueViewPositionsInput,
} from "../Services/IssueViews.ts";

// The chip bar is one column, the way a comment's author and attachment list are: nothing queries
// a view by one of its filters, and the set of filters will grow with the filter bar.
const IssueViewDbRow = IssueView.mapFields(
  Struct.assign({ config: Schema.fromJsonString(IssueViewConfig) }),
);

const VIEW_COLUMNS = `
  id,
  name,
  position,
  config_json AS "config",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const makeIssueViewRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const viewColumns = sql.literal(VIEW_COLUMNS);

  const upsertIssueViewRow = SqlSchema.void({
    Request: IssueView,
    execute: (row) =>
      sql`
        INSERT INTO issue_views (
          id,
          name,
          position,
          config_json,
          created_at,
          updated_at
        )
        VALUES (
          ${row.id},
          ${row.name},
          ${row.position},
          ${JSON.stringify(row.config)},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (id)
        DO UPDATE SET
          name = excluded.name,
          position = excluded.position,
          config_json = excluded.config_json,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
  });

  const listIssueViewRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: IssueViewDbRow,
    execute: () =>
      sql`
        SELECT ${viewColumns}
        FROM issue_views
        ORDER BY position ASC, id ASC
      `,
  });

  const getIssueViewRow = SqlSchema.findOneOption({
    Request: GetIssueViewInput,
    Result: IssueViewDbRow,
    execute: ({ viewId }) =>
      sql`
        SELECT ${viewColumns}
        FROM issue_views
        WHERE id = ${viewId}
      `,
  });

  const deleteIssueViewRow = SqlSchema.void({
    Request: DeleteIssueViewInput,
    execute: ({ viewId }) =>
      sql`
        DELETE FROM issue_views
        WHERE id = ${viewId}
      `,
  });

  const setIssueViewPositionRows = SqlSchema.void({
    Request: SetIssueViewPositionsInput,
    execute: ({ positions, updatedAt }) =>
      sql.withTransaction(
        Effect.forEach(
          positions,
          ({ viewId, position }) =>
            sql`
              UPDATE issue_views
              SET position = ${position},
                  updated_at = ${updatedAt}
              WHERE id = ${viewId}
            `,
          { discard: true },
        ),
      ),
  });

  const listAll: IssueViewRepositoryShape["listAll"] = () =>
    listIssueViewRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueViewRepository.listAll:query",
          "IssueViewRepository.listAll:decodeRows",
        ),
      ),
    );

  const getById: IssueViewRepositoryShape["getById"] = (input) =>
    getIssueViewRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueViewRepository.getById:query",
          "IssueViewRepository.getById:decodeRow",
        ),
      ),
    );

  const upsert: IssueViewRepositoryShape["upsert"] = (row) =>
    upsertIssueViewRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueViewRepository.upsert:query",
          "IssueViewRepository.upsert:encodeRequest",
        ),
      ),
    );

  const deleteById: IssueViewRepositoryShape["deleteById"] = (input) =>
    deleteIssueViewRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueViewRepository.deleteById:query",
          "IssueViewRepository.deleteById:encodeRequest",
        ),
      ),
    );

  const setPositions: IssueViewRepositoryShape["setPositions"] = (input) =>
    setIssueViewPositionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueViewRepository.setPositions:query",
          "IssueViewRepository.setPositions:encodeRequest",
        ),
      ),
    );

  return {
    listAll,
    getById,
    upsert,
    deleteById,
    setPositions,
  } satisfies IssueViewRepositoryShape;
});

export const IssueViewRepositoryLive = Layer.effect(IssueViewRepository, makeIssueViewRepository);
