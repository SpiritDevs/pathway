import { ChatAttachmentId, IssueActor, IssueComment } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  DeleteIssueCommentInput,
  GetIssueCommentInput,
  IssueCommentRepository,
  type IssueCommentRepositoryShape,
  ListIssueCommentsInput,
} from "../Services/IssueComments.ts";

const IssueCommentDbRow = IssueComment.mapFields(
  Struct.assign({
    author: Schema.fromJsonString(IssueActor),
    attachmentIds: Schema.fromJsonString(Schema.Array(ChatAttachmentId)),
  }),
);

const COMMENT_COLUMNS = `
  id,
  issue_id AS "issueId",
  author_json AS "author",
  body,
  attachment_ids_json AS "attachmentIds",
  created_at AS "createdAt",
  edited_at AS "editedAt"
`;

const makeIssueCommentRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const commentColumns = sql.literal(COMMENT_COLUMNS);

  const upsertIssueCommentRow = SqlSchema.void({
    Request: IssueComment,
    execute: (row) =>
      sql`
        INSERT INTO issue_comments (
          id,
          issue_id,
          author_json,
          body,
          attachment_ids_json,
          created_at,
          edited_at
        )
        VALUES (
          ${row.id},
          ${row.issueId},
          ${JSON.stringify(row.author)},
          ${row.body},
          ${JSON.stringify(row.attachmentIds)},
          ${row.createdAt},
          ${row.editedAt}
        )
        ON CONFLICT (id)
        DO UPDATE SET
          issue_id = excluded.issue_id,
          author_json = excluded.author_json,
          body = excluded.body,
          attachment_ids_json = excluded.attachment_ids_json,
          created_at = excluded.created_at,
          edited_at = excluded.edited_at
      `,
  });

  // Two comments posted in the same millisecond order by insertion, the same tiebreak the change
  // log uses: this table is append-and-edit, never re-keyed, so rowid is stable.
  const listIssueCommentRowsByIssue = SqlSchema.findAll({
    Request: ListIssueCommentsInput,
    Result: IssueCommentDbRow,
    execute: ({ issueId }) =>
      sql`
        SELECT ${commentColumns}
        FROM issue_comments
        WHERE issue_id = ${issueId}
        ORDER BY created_at ASC, rowid ASC
      `,
  });

  const getIssueCommentRow = SqlSchema.findOneOption({
    Request: GetIssueCommentInput,
    Result: IssueCommentDbRow,
    execute: ({ commentId }) =>
      sql`
        SELECT ${commentColumns}
        FROM issue_comments
        WHERE id = ${commentId}
      `,
  });

  const deleteIssueCommentRow = SqlSchema.void({
    Request: DeleteIssueCommentInput,
    execute: ({ commentId }) =>
      sql`
        DELETE FROM issue_comments
        WHERE id = ${commentId}
      `,
  });

  const listByIssue: IssueCommentRepositoryShape["listByIssue"] = (input) =>
    listIssueCommentRowsByIssue(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueCommentRepository.listByIssue:query",
          "IssueCommentRepository.listByIssue:decodeRows",
        ),
      ),
    );

  const getById: IssueCommentRepositoryShape["getById"] = (input) =>
    getIssueCommentRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueCommentRepository.getById:query",
          "IssueCommentRepository.getById:decodeRow",
        ),
      ),
    );

  const upsert: IssueCommentRepositoryShape["upsert"] = (row) =>
    upsertIssueCommentRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueCommentRepository.upsert:query",
          "IssueCommentRepository.upsert:encodeRequest",
        ),
      ),
    );

  const deleteById: IssueCommentRepositoryShape["deleteById"] = (input) =>
    deleteIssueCommentRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueCommentRepository.deleteById:query",
          "IssueCommentRepository.deleteById:encodeRequest",
        ),
      ),
    );

  return {
    listByIssue,
    getById,
    upsert,
    deleteById,
  } satisfies IssueCommentRepositoryShape;
});

export const IssueCommentRepositoryLive = Layer.effect(
  IssueCommentRepository,
  makeIssueCommentRepository,
);
