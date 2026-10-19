import { IssueMilestone } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  DeleteIssueMilestoneInput,
  GetIssueMilestoneInput,
  IssueMilestoneRepository,
  type IssueMilestoneRepositoryShape,
  SetIssueMilestonePositionsInput,
} from "../Services/IssueMilestones.ts";

const MILESTONE_COLUMNS = `
  id,
  project_id AS "projectId",
  name,
  description,
  start_date AS "startDate",
  target_date AS "targetDate",
  position,
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const makeIssueMilestoneRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const milestoneColumns = sql.literal(MILESTONE_COLUMNS);

  const upsertIssueMilestoneRow = SqlSchema.void({
    Request: IssueMilestone,
    execute: (row) =>
      sql`
        INSERT INTO issue_milestones (
          id,
          project_id,
          name,
          description,
          start_date,
          target_date,
          position,
          created_at,
          updated_at
        )
        VALUES (
          ${row.id},
          ${row.projectId},
          ${row.name},
          ${row.description},
          ${row.startDate},
          ${row.targetDate},
          ${row.position},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (id)
        DO UPDATE SET
          project_id = excluded.project_id,
          name = excluded.name,
          description = excluded.description,
          start_date = excluded.start_date,
          target_date = excluded.target_date,
          position = excluded.position,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
  });

  const listIssueMilestoneRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: IssueMilestone,
    execute: () =>
      sql`
        SELECT ${milestoneColumns}
        FROM issue_milestones
        ORDER BY project_id ASC, position ASC, id ASC
      `,
  });

  const getIssueMilestoneRow = SqlSchema.findOneOption({
    Request: GetIssueMilestoneInput,
    Result: IssueMilestone,
    execute: ({ milestoneId }) =>
      sql`
        SELECT ${milestoneColumns}
        FROM issue_milestones
        WHERE id = ${milestoneId}
      `,
  });

  const deleteIssueMilestoneRow = SqlSchema.void({
    Request: DeleteIssueMilestoneInput,
    execute: ({ milestoneId }) =>
      sql`
        DELETE FROM issue_milestones
        WHERE id = ${milestoneId}
      `,
  });

  const setIssueMilestonePositionRows = SqlSchema.void({
    Request: SetIssueMilestonePositionsInput,
    execute: ({ positions, updatedAt }) =>
      sql.withTransaction(
        Effect.forEach(
          positions,
          ({ milestoneId, position }) =>
            sql`
              UPDATE issue_milestones
              SET position = ${position},
                  updated_at = ${updatedAt}
              WHERE id = ${milestoneId}
            `,
          { discard: true },
        ),
      ),
  });

  const listAll: IssueMilestoneRepositoryShape["listAll"] = () =>
    listIssueMilestoneRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueMilestoneRepository.listAll:query",
          "IssueMilestoneRepository.listAll:decodeRows",
        ),
      ),
    );

  const getById: IssueMilestoneRepositoryShape["getById"] = (input) =>
    getIssueMilestoneRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueMilestoneRepository.getById:query",
          "IssueMilestoneRepository.getById:decodeRow",
        ),
      ),
    );

  const upsert: IssueMilestoneRepositoryShape["upsert"] = (row) =>
    upsertIssueMilestoneRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueMilestoneRepository.upsert:query",
          "IssueMilestoneRepository.upsert:encodeRequest",
        ),
      ),
    );

  const deleteById: IssueMilestoneRepositoryShape["deleteById"] = (input) =>
    deleteIssueMilestoneRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueMilestoneRepository.deleteById:query",
          "IssueMilestoneRepository.deleteById:encodeRequest",
        ),
      ),
    );

  const setPositions: IssueMilestoneRepositoryShape["setPositions"] = (input) =>
    setIssueMilestonePositionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueMilestoneRepository.setPositions:query",
          "IssueMilestoneRepository.setPositions:encodeRequest",
        ),
      ),
    );

  return {
    listAll,
    getById,
    upsert,
    deleteById,
    setPositions,
  } satisfies IssueMilestoneRepositoryShape;
});

export const IssueMilestoneRepositoryLive = Layer.effect(
  IssueMilestoneRepository,
  makeIssueMilestoneRepository,
);
