import {
  ISSUE_ENRICHMENT_TRANSCRIPT_MAX_CHARS,
  IssueEnrichmentResult,
  IssueEnrichmentRun,
  ModelSelection,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  AppendIssueEnrichmentTranscriptInput,
  FinishIssueEnrichmentRunInput,
  GetIssueEnrichmentRunInput,
  IssueEnrichmentRunRepository,
  type IssueEnrichmentRunRepositoryShape,
  ListIssueEnrichmentRunsInput,
  StartIssueEnrichmentRunInput,
} from "../Services/IssueEnrichmentRuns.ts";

// The model and the structured answer are opaque columns: nothing queries a run by either, and
// the result's shape belongs to the contract rather than to the schema of this table.
const IssueEnrichmentRunDbRow = IssueEnrichmentRun.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    result: Schema.NullOr(Schema.fromJsonString(IssueEnrichmentResult)),
  }),
);

const RUN_COLUMNS = `
  id,
  issue_id AS "issueId",
  state,
  model_selection_json AS "modelSelection",
  transcript,
  result_json AS "result",
  error,
  created_at AS "createdAt",
  started_at AS "startedAt",
  finished_at AS "finishedAt"
`;

const makeIssueEnrichmentRunRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const runColumns = sql.literal(RUN_COLUMNS);

  const insertIssueEnrichmentRunRow = SqlSchema.void({
    Request: IssueEnrichmentRun,
    execute: (row) =>
      sql`
        INSERT INTO issue_enrichment_runs (
          id,
          issue_id,
          state,
          model_selection_json,
          transcript,
          result_json,
          error,
          created_at,
          started_at,
          finished_at
        )
        VALUES (
          ${row.id},
          ${row.issueId},
          ${row.state},
          ${JSON.stringify(row.modelSelection)},
          ${row.transcript},
          ${row.result === null ? null : JSON.stringify(row.result)},
          ${row.error},
          ${row.createdAt},
          ${row.startedAt},
          ${row.finishedAt}
        )
      `,
  });

  const getIssueEnrichmentRunRow = SqlSchema.findOneOption({
    Request: GetIssueEnrichmentRunInput,
    Result: IssueEnrichmentRunDbRow,
    execute: ({ runId }) =>
      sql`
        SELECT ${runColumns}
        FROM issue_enrichment_runs
        WHERE id = ${runId}
      `,
  });

  // Ties on `created_at` break on insertion order rather than on id: two runs can be started
  // inside one millisecond, and a random uuid would then decide which of them reads as newer.
  const listIssueEnrichmentRunRowsByIssue = SqlSchema.findAll({
    Request: ListIssueEnrichmentRunsInput,
    Result: IssueEnrichmentRunDbRow,
    execute: ({ issueId }) =>
      sql`
        SELECT ${runColumns}
        FROM issue_enrichment_runs
        WHERE issue_id = ${issueId}
        ORDER BY created_at DESC, rowid DESC
      `,
  });

  const listUnfinishedIssueEnrichmentRunRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: IssueEnrichmentRunDbRow,
    execute: () =>
      sql`
        SELECT ${runColumns}
        FROM issue_enrichment_runs
        WHERE state IN ('queued', 'running')
        ORDER BY created_at ASC, rowid ASC
      `,
  });

  const startIssueEnrichmentRunRow = SqlSchema.void({
    Request: StartIssueEnrichmentRunInput,
    execute: ({ runId, startedAt }) =>
      sql`
        UPDATE issue_enrichment_runs
        SET state = 'running',
            started_at = ${startedAt}
        WHERE id = ${runId}
      `,
  });

  // Bounded in SQL so two chunks racing cannot lose one, and the *head* is what goes: a run's
  // conclusion is the part anybody rereads.
  const appendIssueEnrichmentTranscriptRow = SqlSchema.void({
    Request: AppendIssueEnrichmentTranscriptInput,
    execute: ({ runId, chunk }) =>
      sql`
        UPDATE issue_enrichment_runs
        SET transcript = CASE
          WHEN length(transcript) + length(${chunk}) <= ${ISSUE_ENRICHMENT_TRANSCRIPT_MAX_CHARS}
            THEN transcript || ${chunk}
          ELSE substr(
            transcript || ${chunk},
            length(transcript) + length(${chunk}) - ${ISSUE_ENRICHMENT_TRANSCRIPT_MAX_CHARS} + 1
          )
        END
        WHERE id = ${runId}
      `,
  });

  const finishIssueEnrichmentRunRow = SqlSchema.void({
    Request: FinishIssueEnrichmentRunInput,
    execute: ({ runId, state, result, error, finishedAt }) =>
      sql`
        UPDATE issue_enrichment_runs
        SET state = ${state},
            result_json = ${result === null ? null : JSON.stringify(result)},
            error = ${error},
            finished_at = ${finishedAt}
        WHERE id = ${runId}
      `,
  });

  const create: IssueEnrichmentRunRepositoryShape["create"] = (row) =>
    insertIssueEnrichmentRunRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueEnrichmentRunRepository.create:query",
          "IssueEnrichmentRunRepository.create:encodeRequest",
        ),
      ),
    );

  const getById: IssueEnrichmentRunRepositoryShape["getById"] = (input) =>
    getIssueEnrichmentRunRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueEnrichmentRunRepository.getById:query",
          "IssueEnrichmentRunRepository.getById:decodeRow",
        ),
      ),
    );

  const listByIssue: IssueEnrichmentRunRepositoryShape["listByIssue"] = (input) =>
    listIssueEnrichmentRunRowsByIssue(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueEnrichmentRunRepository.listByIssue:query",
          "IssueEnrichmentRunRepository.listByIssue:decodeRows",
        ),
      ),
    );

  const listUnfinished: IssueEnrichmentRunRepositoryShape["listUnfinished"] = () =>
    listUnfinishedIssueEnrichmentRunRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueEnrichmentRunRepository.listUnfinished:query",
          "IssueEnrichmentRunRepository.listUnfinished:decodeRows",
        ),
      ),
    );

  const start: IssueEnrichmentRunRepositoryShape["start"] = (input) =>
    startIssueEnrichmentRunRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueEnrichmentRunRepository.start:query",
          "IssueEnrichmentRunRepository.start:encodeRequest",
        ),
      ),
    );

  const appendTranscript: IssueEnrichmentRunRepositoryShape["appendTranscript"] = (input) =>
    appendIssueEnrichmentTranscriptRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueEnrichmentRunRepository.appendTranscript:query",
          "IssueEnrichmentRunRepository.appendTranscript:encodeRequest",
        ),
      ),
    );

  const finish: IssueEnrichmentRunRepositoryShape["finish"] = (input) =>
    finishIssueEnrichmentRunRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueEnrichmentRunRepository.finish:query",
          "IssueEnrichmentRunRepository.finish:encodeRequest",
        ),
      ),
    );

  return {
    create,
    getById,
    listByIssue,
    listUnfinished,
    start,
    appendTranscript,
    finish,
  } satisfies IssueEnrichmentRunRepositoryShape;
});

export const IssueEnrichmentRunRepositoryLive = Layer.effect(
  IssueEnrichmentRunRepository,
  makeIssueEnrichmentRunRepository,
);
