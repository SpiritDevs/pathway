/**
 * The Pathway server's implementation of the cloud-sync SQLite executor seam.
 *
 * `@spiritdevs/client-runtime`'s `SqliteSyncStore` owns its `cloud_sync_*` tables and migrations;
 * all it asks of a host is a way to run single statements and a transaction combinator. Here that
 * host is this process's `SqlClient` (the `node:sqlite`-backed client every persistence service
 * shares), so the sync replica lands in the same database file as the rest of the server's state
 * without adding anything to the server's own migration chain in `persistence/Migrations.ts`.
 *
 * @module cloud/syncSqliteExecutor
 */
import {
  SqliteSyncExecutorError,
  type SqliteSyncExecutor,
  type SqliteSyncRow,
  type SqliteSyncValue,
} from "@spiritdevs/client-runtime/sync";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { SqlError } from "effect/unstable/sql/SqlError";

const toExecutorError = (error: SqlError): SqliteSyncExecutorError =>
  new SqliteSyncExecutorError({ message: error.message });

const isSqlError = (error: unknown): error is SqlError =>
  typeof error === "object" &&
  error !== null &&
  (error as { readonly _tag?: unknown })._tag === "SqlError";

/**
 * Builds a {@link SqliteSyncExecutor} over the ambient {@link SqlClient.SqlClient}. The client
 * serializes statements on one connection and `withTransaction` maps onto its BEGIN/ROLLBACK, so
 * the adapter's atomicity contract holds exactly as it does for the server's own stores.
 */
export const makeSyncSqliteExecutor: Effect.Effect<SqliteSyncExecutor, never, SqlClient.SqlClient> =
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    const exec = (statement: string): Effect.Effect<void, SqliteSyncExecutorError> =>
      sql.unsafe(statement).unprepared.pipe(Effect.asVoid, Effect.mapError(toExecutorError));

    const run = (
      statement: string,
      params: ReadonlyArray<SqliteSyncValue>,
    ): Effect.Effect<void, SqliteSyncExecutorError> =>
      sql.unsafe(statement, params).pipe(Effect.asVoid, Effect.mapError(toExecutorError));

    const all = (
      statement: string,
      params: ReadonlyArray<SqliteSyncValue>,
    ): Effect.Effect<ReadonlyArray<SqliteSyncRow>, SqliteSyncExecutorError> =>
      sql.unsafe<SqliteSyncRow>(statement, params).pipe(Effect.mapError(toExecutorError));

    const withTransaction = <A, E>(
      effect: Effect.Effect<A, E>,
    ): Effect.Effect<A, E | SqliteSyncExecutorError> =>
      sql
        .withTransaction(effect)
        .pipe(
          Effect.mapError((error: E | SqlError): E | SqliteSyncExecutorError =>
            isSqlError(error) ? toExecutorError(error) : error,
          ),
        );

    return { exec, run, all, withTransaction } satisfies SqliteSyncExecutor;
  });
