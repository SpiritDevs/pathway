import { IssueCycle } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  CompleteIssueCycleInput,
  DeleteIssueCycleInput,
  GetIssueCycleInput,
  IssueCycleRepository,
  type IssueCycleRepositoryShape,
} from "../Services/IssueCycles.ts";

const CYCLE_COLUMNS = `
  id,
  name,
  start_date AS "startDate",
  end_date AS "endDate",
  completed_at AS "completedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

const makeIssueCycleRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const cycleColumns = sql.literal(CYCLE_COLUMNS);

  const upsertIssueCycleRow = SqlSchema.void({
    Request: IssueCycle,
    execute: (row) =>
      sql`
        INSERT INTO issue_cycles (
          id,
          name,
          start_date,
          end_date,
          completed_at,
          created_at,
          updated_at
        )
        VALUES (
          ${row.id},
          ${row.name},
          ${row.startDate},
          ${row.endDate},
          ${row.completedAt},
          ${row.createdAt},
          ${row.updatedAt}
        )
        ON CONFLICT (id)
        DO UPDATE SET
          name = excluded.name,
          start_date = excluded.start_date,
          end_date = excluded.end_date,
          completed_at = excluded.completed_at,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `,
  });

  const listIssueCycleRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: IssueCycle,
    execute: () =>
      sql`
        SELECT ${cycleColumns}
        FROM issue_cycles
        ORDER BY start_date ASC, id ASC
      `,
  });

  const getIssueCycleRow = SqlSchema.findOneOption({
    Request: GetIssueCycleInput,
    Result: IssueCycle,
    execute: ({ cycleId }) =>
      sql`
        SELECT ${cycleColumns}
        FROM issue_cycles
        WHERE id = ${cycleId}
      `,
  });

  const deleteIssueCycleRow = SqlSchema.void({
    Request: DeleteIssueCycleInput,
    execute: ({ cycleId }) =>
      sql`
        DELETE FROM issue_cycles
        WHERE id = ${cycleId}
      `,
  });

  // `completed_at IS NULL` in the predicate, not just in the caller: two readers opening the
  // tracker at once must not both carry the same cycle over.
  const completeIssueCycleRow = SqlSchema.void({
    Request: CompleteIssueCycleInput,
    execute: ({ cycleId, completedAt }) =>
      sql`
        UPDATE issue_cycles
        SET completed_at = ${completedAt},
            updated_at = ${completedAt}
        WHERE id = ${cycleId}
          AND completed_at IS NULL
      `,
  });

  const listAll: IssueCycleRepositoryShape["listAll"] = () =>
    listIssueCycleRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueCycleRepository.listAll:query",
          "IssueCycleRepository.listAll:decodeRows",
        ),
      ),
    );

  const getById: IssueCycleRepositoryShape["getById"] = (input) =>
    getIssueCycleRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueCycleRepository.getById:query",
          "IssueCycleRepository.getById:decodeRow",
        ),
      ),
    );

  const upsert: IssueCycleRepositoryShape["upsert"] = (row) =>
    upsertIssueCycleRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueCycleRepository.upsert:query",
          "IssueCycleRepository.upsert:encodeRequest",
        ),
      ),
    );

  const deleteById: IssueCycleRepositoryShape["deleteById"] = (input) =>
    deleteIssueCycleRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueCycleRepository.deleteById:query",
          "IssueCycleRepository.deleteById:encodeRequest",
        ),
      ),
    );

  const complete: IssueCycleRepositoryShape["complete"] = (input) =>
    completeIssueCycleRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueCycleRepository.complete:query",
          "IssueCycleRepository.complete:encodeRequest",
        ),
      ),
    );

  return {
    listAll,
    getById,
    upsert,
    deleteById,
    complete,
  } satisfies IssueCycleRepositoryShape;
});

export const IssueCycleRepositoryLive = Layer.effect(
  IssueCycleRepository,
  makeIssueCycleRepository,
);
