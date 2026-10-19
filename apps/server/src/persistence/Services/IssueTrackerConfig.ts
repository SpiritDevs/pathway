/**
 * IssueTrackerConfigRepository - Persistence interface for the single config row.
 *
 * One prefix and one counter per environment. The counter is the reason this is a repository
 * rather than a setting: handing out `ISS-12` twice is the one failure the tracker cannot recover
 * from, so allocation is a transaction, not a read followed by a write.
 *
 * @module IssueTrackerConfigRepository
 */
import { IssueKey, IssueKeyPrefix, IssueTrackerConfig, PositiveInt } from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { IssueTrackerRepositoryError } from "../Errors.ts";

export const SetIssueKeyPrefixInput = Schema.Struct({ keyPrefix: IssueKeyPrefix });
export type SetIssueKeyPrefixInput = typeof SetIssueKeyPrefixInput.Type;

export const ReserveIssueKeyNumbersInput = Schema.Struct({ throughNumber: PositiveInt });
export type ReserveIssueKeyNumbersInput = typeof ReserveIssueKeyNumbersInput.Type;

/**
 * IssueTrackerConfigRepositoryShape - Service API for the tracker config row.
 */
export interface IssueTrackerConfigRepositoryShape {
  /**
   * Read the config row.
   *
   * The row is seeded by migration 041, so its absence is a storage failure rather than an empty
   * result.
   */
  readonly get: () => Effect.Effect<IssueTrackerConfig, IssueTrackerRepositoryError>;

  /**
   * Take the next key and advance the counter in one transaction.
   *
   * Numbers are never reused, so a deleted key is never handed out twice.
   */
  readonly allocateKey: () => Effect.Effect<IssueKey, IssueTrackerRepositoryError>;

  /**
   * Move the counter past `throughNumber`, never backwards.
   *
   * A CSV import keeps the keys the export carried, so the counter has to skip everything they
   * used — in one write rather than one allocation per number, because an export that starts at
   * `PAT-4000` would otherwise cost four thousand transactions.
   */
  readonly reserveKeyNumbers: (
    input: ReserveIssueKeyNumbersInput,
  ) => Effect.Effect<IssueTrackerConfig, IssueTrackerRepositoryError>;

  /**
   * Rename the prefix. Existing keys keep the prefix they were issued with.
   */
  readonly setPrefix: (
    input: SetIssueKeyPrefixInput,
  ) => Effect.Effect<IssueTrackerConfig, IssueTrackerRepositoryError>;
}

/**
 * IssueTrackerConfigRepository - Service tag for tracker config persistence.
 */
export class IssueTrackerConfigRepository extends Context.Service<
  IssueTrackerConfigRepository,
  IssueTrackerConfigRepositoryShape
>()("@spiritdevs/pathway/persistence/Services/IssueTrackerConfig/IssueTrackerConfigRepository") {}
