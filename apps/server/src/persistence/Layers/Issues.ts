import {
  IssueAssignee,
  IssueAutomationAssignment,
  IssueSlackSource,
  ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  GetIssueByKeyInput,
  GetIssueInput,
  IssueRecord,
  IssueRepository,
  type IssueRepositoryShape,
  ReassignIssueStatusInput,
  RestoreIssueInput,
  SetIssueCycleInput,
  SetIssueMilestoneInput,
  SetIssueSortOrderInput,
  SoftDeleteIssueInput,
} from "../Services/Issues.ts";

const IssueDbRow = IssueRecord.mapFields(
  Struct.assign({
    assignee: Schema.NullOr(Schema.fromJsonString(IssueAssignee)),
    workModelSelection: Schema.NullOr(Schema.fromJsonString(ModelSelection)),
    automationAssignment: Schema.NullOr(Schema.fromJsonString(IssueAutomationAssignment)),
    triage: Schema.BooleanFromBit,
    slackSource: Schema.NullOr(Schema.fromJsonString(IssueSlackSource)),
  }),
);

// The Slack source is four columns rather than one blob — the poller may want to ask which issue
// a channel and ts became — and is reassembled here so nothing above the repository sees them
// apart. `slack_channel_id` is the presence flag: an issue that did not come from Slack has none.
const ISSUE_COLUMNS = `
  id,
  key,
  title,
  description,
  status_id AS "statusId",
  priority,
  assignee_json AS "assignee",
  work_model_selection_json AS "workModelSelection",
  automation_assignment_json AS "automationAssignment",
  project_id AS "projectId",
  milestone_id AS "milestoneId",
  cycle_id AS "cycleId",
  parent_id AS "parentId",
  sort_order AS "sortOrder",
  due_date AS "dueDate",
  triage,
  CASE
    WHEN slack_channel_id IS NULL THEN NULL
    ELSE json_object(
      'issueId', id,
      'channelId', slack_channel_id,
      'messageTs', slack_message_ts,
      'permalink', slack_permalink,
      'authorName', slack_author_name
    )
  END AS "slackSource",
  created_at AS "createdAt",
  updated_at AS "updatedAt",
  deleted_at AS "deletedAt"
`;

const makeIssueRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const issueColumns = sql.literal(ISSUE_COLUMNS);

  const upsertIssueRow = SqlSchema.void({
    Request: IssueRecord,
    execute: (row) =>
      sql`
        INSERT INTO issues (
          id,
          key,
          title,
          description,
          status_id,
          priority,
          assignee_json,
          work_model_selection_json,
          automation_assignment_json,
          project_id,
          milestone_id,
          cycle_id,
          parent_id,
          sort_order,
          due_date,
          triage,
          slack_channel_id,
          slack_message_ts,
          slack_permalink,
          slack_author_name,
          created_at,
          updated_at,
          deleted_at
        )
        VALUES (
          ${row.id},
          ${row.key},
          ${row.title},
          ${row.description},
          ${row.statusId},
          ${row.priority},
          ${row.assignee === null ? null : JSON.stringify(row.assignee)},
          ${row.workModelSelection == null ? null : JSON.stringify(row.workModelSelection)},
          ${row.automationAssignment == null ? null : JSON.stringify(row.automationAssignment)},
          ${row.projectId},
          ${row.milestoneId},
          ${row.cycleId},
          ${row.parentId},
          ${row.sortOrder},
          ${row.dueDate},
          ${row.triage ? 1 : 0},
          ${row.slackSource?.channelId ?? null},
          ${row.slackSource?.messageTs ?? null},
          ${row.slackSource?.permalink ?? null},
          ${row.slackSource?.authorName ?? null},
          ${row.createdAt},
          ${row.updatedAt},
          ${row.deletedAt}
        )
        ON CONFLICT (id)
        DO UPDATE SET
          key = excluded.key,
          title = excluded.title,
          description = excluded.description,
          status_id = excluded.status_id,
          priority = excluded.priority,
          assignee_json = excluded.assignee_json,
          work_model_selection_json = excluded.work_model_selection_json,
          automation_assignment_json = excluded.automation_assignment_json,
          project_id = excluded.project_id,
          milestone_id = excluded.milestone_id,
          cycle_id = excluded.cycle_id,
          parent_id = excluded.parent_id,
          sort_order = excluded.sort_order,
          due_date = excluded.due_date,
          triage = excluded.triage,
          slack_channel_id = excluded.slack_channel_id,
          slack_message_ts = excluded.slack_message_ts,
          slack_permalink = excluded.slack_permalink,
          slack_author_name = excluded.slack_author_name,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at,
          deleted_at = excluded.deleted_at
      `,
  });

  const listAllIssueRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: IssueDbRow,
    execute: () =>
      sql`
        SELECT ${issueColumns}
        FROM issues
        ORDER BY sort_order ASC, id ASC
      `,
  });

  const listLiveIssueRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: IssueDbRow,
    execute: () =>
      sql`
        SELECT ${issueColumns}
        FROM issues
        WHERE deleted_at IS NULL
        ORDER BY sort_order ASC, id ASC
      `,
  });

  const listDeletedIssueRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: IssueDbRow,
    execute: () =>
      sql`
        SELECT ${issueColumns}
        FROM issues
        WHERE deleted_at IS NOT NULL
        ORDER BY deleted_at DESC, id ASC
      `,
  });

  const getIssueRowById = SqlSchema.findOneOption({
    Request: GetIssueInput,
    Result: IssueDbRow,
    execute: ({ issueId }) =>
      sql`
        SELECT ${issueColumns}
        FROM issues
        WHERE id = ${issueId}
      `,
  });

  const getIssueRowByKey = SqlSchema.findOneOption({
    Request: GetIssueByKeyInput,
    Result: IssueDbRow,
    execute: ({ key }) =>
      sql`
        SELECT ${issueColumns}
        FROM issues
        WHERE key = ${key}
      `,
  });

  const softDeleteIssueRow = SqlSchema.void({
    Request: SoftDeleteIssueInput,
    execute: ({ issueId, deletedAt }) =>
      sql`
        UPDATE issues
        SET deleted_at = ${deletedAt},
            updated_at = ${deletedAt}
        WHERE id = ${issueId}
      `,
  });

  const restoreIssueRow = SqlSchema.void({
    Request: RestoreIssueInput,
    execute: ({ issueId, updatedAt }) =>
      sql`
        UPDATE issues
        SET deleted_at = NULL,
            updated_at = ${updatedAt}
        WHERE id = ${issueId}
      `,
  });

  const setIssueSortOrderRow = SqlSchema.void({
    Request: SetIssueSortOrderInput,
    execute: ({ issueId, sortOrder, statusId, updatedAt }) =>
      sql`
        UPDATE issues
        SET sort_order = ${sortOrder},
            status_id = COALESCE(${statusId}, status_id),
            updated_at = ${updatedAt}
        WHERE id = ${issueId}
      `,
  });

  const reassignIssueStatusRows = SqlSchema.void({
    Request: ReassignIssueStatusInput,
    execute: ({ fromStatusId, toStatusId, updatedAt }) =>
      sql`
        UPDATE issues
        SET status_id = ${toStatusId},
            updated_at = ${updatedAt}
        WHERE status_id = ${fromStatusId}
      `,
  });

  const setIssueMilestoneRows = SqlSchema.void({
    Request: SetIssueMilestoneInput,
    execute: ({ issueIds, milestoneId, updatedAt }) =>
      sql.withTransaction(
        Effect.forEach(
          issueIds,
          (issueId) =>
            sql`
              UPDATE issues
              SET milestone_id = ${milestoneId},
                  updated_at = ${updatedAt}
              WHERE id = ${issueId}
            `,
          { discard: true },
        ),
      ),
  });

  const setIssueCycleRows = SqlSchema.void({
    Request: SetIssueCycleInput,
    execute: ({ issueIds, cycleId, updatedAt }) =>
      sql.withTransaction(
        Effect.forEach(
          issueIds,
          (issueId) =>
            sql`
              UPDATE issues
              SET cycle_id = ${cycleId},
                  updated_at = ${updatedAt}
              WHERE id = ${issueId}
            `,
          { discard: true },
        ),
      ),
  });

  const listAll: IssueRepositoryShape["listAll"] = () =>
    listAllIssueRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueRepository.listAll:query",
          "IssueRepository.listAll:decodeRows",
        ),
      ),
    );

  const listLive: IssueRepositoryShape["listLive"] = () =>
    listLiveIssueRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueRepository.listLive:query",
          "IssueRepository.listLive:decodeRows",
        ),
      ),
    );

  const listDeleted: IssueRepositoryShape["listDeleted"] = () =>
    listDeletedIssueRows().pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueRepository.listDeleted:query",
          "IssueRepository.listDeleted:decodeRows",
        ),
      ),
    );

  const getById: IssueRepositoryShape["getById"] = (input) =>
    getIssueRowById(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueRepository.getById:query",
          "IssueRepository.getById:decodeRow",
        ),
      ),
    );

  const getByKey: IssueRepositoryShape["getByKey"] = (input) =>
    getIssueRowByKey(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueRepository.getByKey:query",
          "IssueRepository.getByKey:decodeRow",
        ),
      ),
    );

  const upsert: IssueRepositoryShape["upsert"] = (row) =>
    upsertIssueRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueRepository.upsert:query",
          "IssueRepository.upsert:encodeRequest",
        ),
      ),
    );

  const upsertMany: IssueRepositoryShape["upsertMany"] = (rows) =>
    sql
      .withTransaction(Effect.forEach(rows, upsertIssueRow, { discard: true }))
      .pipe(
        Effect.mapError(
          toPersistenceSqlOrDecodeError(
            "IssueRepository.upsertMany:query",
            "IssueRepository.upsertMany:encodeRequest",
          ),
        ),
      );

  const softDelete: IssueRepositoryShape["softDelete"] = (input) =>
    softDeleteIssueRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueRepository.softDelete:query",
          "IssueRepository.softDelete:encodeRequest",
        ),
      ),
    );

  const restore: IssueRepositoryShape["restore"] = (input) =>
    restoreIssueRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueRepository.restore:query",
          "IssueRepository.restore:encodeRequest",
        ),
      ),
    );

  const setSortOrder: IssueRepositoryShape["setSortOrder"] = (input) =>
    setIssueSortOrderRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueRepository.setSortOrder:query",
          "IssueRepository.setSortOrder:encodeRequest",
        ),
      ),
    );

  const reassignStatus: IssueRepositoryShape["reassignStatus"] = (input) =>
    reassignIssueStatusRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueRepository.reassignStatus:query",
          "IssueRepository.reassignStatus:encodeRequest",
        ),
      ),
    );

  const setMilestone: IssueRepositoryShape["setMilestone"] = (input) =>
    setIssueMilestoneRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueRepository.setMilestone:query",
          "IssueRepository.setMilestone:encodeRequest",
        ),
      ),
    );

  const setCycle: IssueRepositoryShape["setCycle"] = (input) =>
    setIssueCycleRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueRepository.setCycle:query",
          "IssueRepository.setCycle:encodeRequest",
        ),
      ),
    );

  return {
    listAll,
    listLive,
    listDeleted,
    getById,
    getByKey,
    upsert,
    upsertMany,
    softDelete,
    restore,
    setSortOrder,
    reassignStatus,
    setMilestone,
    setCycle,
  } satisfies IssueRepositoryShape;
});

export const IssueRepositoryLive = Layer.effect(IssueRepository, makeIssueRepository);
