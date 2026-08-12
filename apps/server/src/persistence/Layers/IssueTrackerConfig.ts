import { IssueKey, IssueTrackerConfig } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { PersistenceSqlError, toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  IssueTrackerConfigRepository,
  type IssueTrackerConfigRepositoryShape,
  type ReserveIssueKeyNumbersInput,
  SetIssueKeyPrefixInput,
} from "../Services/IssueTrackerConfig.ts";

/** Migration 041 seeds the row, so a miss here is a damaged database, not an empty tracker. */
const requireConfigRow =
  <A>(operation: string) =>
  (row: Option.Option<A>): Effect.Effect<A, PersistenceSqlError> =>
    Option.match(row, {
      onNone: () =>
        Effect.fail(
          new PersistenceSqlError({
            operation,
            detail: "issue_tracker_config row is missing",
          }),
        ),
      onSome: (value) => Effect.succeed(value),
    });

const makeIssueTrackerConfigRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const readIssueTrackerConfigRow = SqlSchema.findOneOption({
    Request: Schema.Void,
    Result: IssueTrackerConfig,
    execute: () =>
      sql`
        SELECT
          key_prefix AS "keyPrefix",
          next_number AS "nextNumber"
        FROM issue_tracker_config
        WHERE id = 1
      `,
  });

  /**
   * Read and increment under one transaction rather than `RETURNING`: the sqlite clients
   * serialize transactions on a single connection permit, so two fibers cannot read the same
   * number.
   */
  const allocateIssueKeyRow = sql.withTransaction(
    Effect.gen(function* () {
      const config = yield* readIssueTrackerConfigRow();
      if (Option.isNone(config)) {
        return Option.none<IssueKey>();
      }
      yield* sql`
        UPDATE issue_tracker_config
        SET next_number = next_number + 1
        WHERE id = 1
      `;
      return Option.some<IssueKey>(`${config.value.keyPrefix}-${config.value.nextNumber}`);
    }),
  );

  const reserveIssueKeyNumbersRow = (input: ReserveIssueKeyNumbersInput) =>
    sql.withTransaction(
      Effect.gen(function* () {
        // MAX, not assignment: a re-run of an import must not hand back numbers already issued.
        yield* sql`
          UPDATE issue_tracker_config
          SET next_number = MAX(next_number, ${input.throughNumber + 1})
          WHERE id = 1
        `;
        return yield* readIssueTrackerConfigRow();
      }),
    );

  const setIssueKeyPrefixRow = (input: SetIssueKeyPrefixInput) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          UPDATE issue_tracker_config
          SET key_prefix = ${input.keyPrefix}
          WHERE id = 1
        `;
        return yield* readIssueTrackerConfigRow();
      }),
    );

  const get: IssueTrackerConfigRepositoryShape["get"] = () =>
    readIssueTrackerConfigRow().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueTrackerConfigRepository.get:query",
          "IssueTrackerConfigRepository.get:decodeRow",
        ),
      ),
      Effect.flatMap(requireConfigRow("IssueTrackerConfigRepository.get:missingRow")),
    );

  const allocateKey: IssueTrackerConfigRepositoryShape["allocateKey"] = () =>
    allocateIssueKeyRow.pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueTrackerConfigRepository.allocateKey:query",
          "IssueTrackerConfigRepository.allocateKey:decodeRow",
        ),
      ),
      Effect.flatMap(requireConfigRow("IssueTrackerConfigRepository.allocateKey:missingRow")),
    );

  const reserveKeyNumbers: IssueTrackerConfigRepositoryShape["reserveKeyNumbers"] = (input) =>
    reserveIssueKeyNumbersRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueTrackerConfigRepository.reserveKeyNumbers:query",
          "IssueTrackerConfigRepository.reserveKeyNumbers:decodeRow",
        ),
      ),
      Effect.flatMap(requireConfigRow("IssueTrackerConfigRepository.reserveKeyNumbers:missingRow")),
    );

  const setPrefix: IssueTrackerConfigRepositoryShape["setPrefix"] = (input) =>
    setIssueKeyPrefixRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueTrackerConfigRepository.setPrefix:query",
          "IssueTrackerConfigRepository.setPrefix:decodeRow",
        ),
      ),
      Effect.flatMap(requireConfigRow("IssueTrackerConfigRepository.setPrefix:missingRow")),
    );

  return {
    get,
    allocateKey,
    reserveKeyNumbers,
    setPrefix,
  } satisfies IssueTrackerConfigRepositoryShape;
});

export const IssueTrackerConfigRepositoryLive = Layer.effect(
  IssueTrackerConfigRepository,
  makeIssueTrackerConfigRepository,
);
