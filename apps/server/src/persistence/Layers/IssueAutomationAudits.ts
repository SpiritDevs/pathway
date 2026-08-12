import { ModelSelection } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  IssueAutomationAuditRepository,
  IssueAutomationAuditRun,
  type IssueAutomationAuditRepositoryShape,
} from "../Services/IssueAutomationAudits.ts";

const AuditDbRow = IssueAutomationAuditRun.mapFields(
  Struct.assign({
    modelSelection: Schema.fromJsonString(ModelSelection),
    findings: Schema.fromJsonString(Schema.Array(Schema.String)),
  }),
);
const encodeModelSelection = Schema.encodeSync(Schema.fromJsonString(ModelSelection));
const encodeFindings = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

const COLUMNS = `
  id,
  issue_id AS "issueId",
  trigger_key AS "triggerKey",
  rule_id AS "ruleId",
  auditor_index AS "auditorIndex",
  model_selection_json AS "modelSelection",
  state,
  verdict,
  summary,
  COALESCE(findings_json, '[]') AS "findings",
  error,
  remediation_cycle AS "remediationCycle",
  created_at AS "createdAt",
  finished_at AS "finishedAt"
`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql.literal(COLUMNS);

  const releaseInterruptedClaims: IssueAutomationAuditRepositoryShape["releaseInterruptedClaims"] =
    () =>
      sql`DELETE FROM issue_automation_audits WHERE state = 'running'`.pipe(
        Effect.asVoid,
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "IssueAutomationAuditRepository.releaseInterruptedClaims:query",
            "IssueAutomationAuditRepository.releaseInterruptedClaims:decodeRequest",
          ),
        ),
      );

  const claim: IssueAutomationAuditRepositoryShape["claim"] = (run) =>
    Effect.gen(function* () {
      yield* sql`
        INSERT OR IGNORE INTO issue_automation_audits (
          id, issue_id, trigger_key, rule_id, auditor_index, model_selection_json, state,
          verdict, summary, findings_json, error, remediation_cycle, created_at, finished_at
        ) VALUES (
          ${run.id}, ${run.issueId}, ${run.triggerKey}, ${run.ruleId}, ${run.auditorIndex},
          ${encodeModelSelection(run.modelSelection)}, ${run.state}, ${run.verdict}, ${run.summary},
          ${encodeFindings(run.findings)}, ${run.error}, ${run.remediationCycle}, ${run.createdAt},
          ${run.finishedAt}
        )
      `;
      const rows = yield* sql<{ readonly id: string }>`
        SELECT id FROM issue_automation_audits
        WHERE issue_id = ${run.issueId}
          AND trigger_key = ${run.triggerKey}
          AND rule_id = ${run.ruleId}
          AND auditor_index = ${run.auditorIndex}
      `;
      return rows[0]?.id === run.id;
    }).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueAutomationAuditRepository.claim:query",
          "IssueAutomationAuditRepository.claim:encodeRequest",
        ),
      ),
    );

  const finish: IssueAutomationAuditRepositoryShape["finish"] = (run) =>
    sql`
      UPDATE issue_automation_audits
      SET state = ${run.state}, verdict = ${run.verdict}, summary = ${run.summary},
          findings_json = ${encodeFindings(run.findings)}, error = ${run.error},
          remediation_cycle = ${run.remediationCycle}, finished_at = ${run.finishedAt}
      WHERE id = ${run.id}
    `.pipe(
      Effect.asVoid,
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueAutomationAuditRepository.finish:query",
          "IssueAutomationAuditRepository.finish:encodeRequest",
        ),
      ),
    );

  const listRows = SqlSchema.findAll({
    Request: Schema.Struct({
      issueId: IssueAutomationAuditRun.fields.issueId,
      triggerKey: Schema.String,
    }),
    Result: AuditDbRow,
    execute: ({ issueId, triggerKey }) => sql`
      SELECT ${columns}
      FROM issue_automation_audits
      WHERE issue_id = ${issueId} AND trigger_key = ${triggerKey}
      ORDER BY rule_id ASC, auditor_index ASC
    `,
  });

  const listByTrigger: IssueAutomationAuditRepositoryShape["listByTrigger"] = (input) =>
    listRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueAutomationAuditRepository.listByTrigger:query",
          "IssueAutomationAuditRepository.listByTrigger:decodeRows",
        ),
      ),
    );

  const countChangesRequested: IssueAutomationAuditRepositoryShape["countChangesRequested"] = (
    issueId,
  ) =>
    sql<{ readonly count: number }>`
        SELECT COUNT(DISTINCT trigger_key) AS count
        FROM issue_automation_audits
        WHERE issue_id = ${issueId} AND verdict = 'changes_requested'
      `.pipe(
      Effect.map((rows) => rows[0]?.count ?? 0),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueAutomationAuditRepository.countChangesRequested:query",
          "IssueAutomationAuditRepository.countChangesRequested:decodeRow",
        ),
      ),
    );

  return {
    releaseInterruptedClaims,
    claim,
    finish,
    listByTrigger,
    countChangesRequested,
  } satisfies IssueAutomationAuditRepositoryShape;
});

export const IssueAutomationAuditRepositoryLive = Layer.effect(
  IssueAutomationAuditRepository,
  make,
);
