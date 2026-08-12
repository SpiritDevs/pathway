import { IssueTodo } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  DeleteIssueTodoInput,
  GetIssueTodoInput,
  IssueTodoRepository,
  type IssueTodoRepositoryShape,
  ListIssueTodosInput,
  SetIssueTodoPositionsInput,
} from "../Services/IssueTodos.ts";

const IssueTodoDbRow = IssueTodo.mapFields(Struct.assign({ done: Schema.BooleanFromBit }));

const TODO_COLUMNS = `
  id,
  issue_id AS "issueId",
  text,
  done,
  position
`;

const makeIssueTodoRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const todoColumns = sql.literal(TODO_COLUMNS);

  const upsertIssueTodoRow = SqlSchema.void({
    Request: IssueTodo,
    execute: (row) =>
      sql`
        INSERT INTO issue_todos (
          id,
          issue_id,
          text,
          done,
          position
        )
        VALUES (
          ${row.id},
          ${row.issueId},
          ${row.text},
          ${row.done ? 1 : 0},
          ${row.position}
        )
        ON CONFLICT (id)
        DO UPDATE SET
          issue_id = excluded.issue_id,
          text = excluded.text,
          done = excluded.done,
          position = excluded.position
      `,
  });

  const listIssueTodoRowsByIssue = SqlSchema.findAll({
    Request: ListIssueTodosInput,
    Result: IssueTodoDbRow,
    execute: ({ issueId }) =>
      sql`
        SELECT ${todoColumns}
        FROM issue_todos
        WHERE issue_id = ${issueId}
        ORDER BY position ASC, id ASC
      `,
  });

  const getIssueTodoRow = SqlSchema.findOneOption({
    Request: GetIssueTodoInput,
    Result: IssueTodoDbRow,
    execute: ({ todoId }) =>
      sql`
        SELECT ${todoColumns}
        FROM issue_todos
        WHERE id = ${todoId}
      `,
  });

  const deleteIssueTodoRow = SqlSchema.void({
    Request: DeleteIssueTodoInput,
    execute: ({ todoId }) =>
      sql`
        DELETE FROM issue_todos
        WHERE id = ${todoId}
      `,
  });

  const setIssueTodoPositionRows = SqlSchema.void({
    Request: SetIssueTodoPositionsInput,
    execute: ({ positions }) =>
      sql.withTransaction(
        Effect.forEach(
          positions,
          ({ todoId, position }) =>
            sql`
              UPDATE issue_todos
              SET position = ${position}
              WHERE id = ${todoId}
            `,
          { discard: true },
        ),
      ),
  });

  const listByIssue: IssueTodoRepositoryShape["listByIssue"] = (input) =>
    listIssueTodoRowsByIssue(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueTodoRepository.listByIssue:query",
          "IssueTodoRepository.listByIssue:decodeRows",
        ),
      ),
    );

  const getById: IssueTodoRepositoryShape["getById"] = (input) =>
    getIssueTodoRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueTodoRepository.getById:query",
          "IssueTodoRepository.getById:decodeRow",
        ),
      ),
    );

  const upsert: IssueTodoRepositoryShape["upsert"] = (row) =>
    upsertIssueTodoRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueTodoRepository.upsert:query",
          "IssueTodoRepository.upsert:encodeRequest",
        ),
      ),
    );

  const deleteById: IssueTodoRepositoryShape["deleteById"] = (input) =>
    deleteIssueTodoRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueTodoRepository.deleteById:query",
          "IssueTodoRepository.deleteById:encodeRequest",
        ),
      ),
    );

  const setPositions: IssueTodoRepositoryShape["setPositions"] = (input) =>
    setIssueTodoPositionRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueTodoRepository.setPositions:query",
          "IssueTodoRepository.setPositions:encodeRequest",
        ),
      ),
    );

  return {
    listByIssue,
    getById,
    upsert,
    deleteById,
    setPositions,
  } satisfies IssueTodoRepositoryShape;
});

export const IssueTodoRepositoryLive = Layer.effect(IssueTodoRepository, makeIssueTodoRepository);
