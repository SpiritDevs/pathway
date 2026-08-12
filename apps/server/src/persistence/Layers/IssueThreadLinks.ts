import { IssueThreadLink } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  IssueThreadLinkRepository,
  type IssueThreadLinkRepositoryShape,
  ListIssueThreadLinksByIssueInput,
  ListIssueThreadLinksByThreadInput,
  UnlinkIssueThreadInput,
} from "../Services/IssueThreadLinks.ts";

const LINK_COLUMNS = `
  issue_id AS "issueId",
  thread_id AS "threadId",
  created_at AS "createdAt",
  origin
`;

const makeIssueThreadLinkRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const linkColumns = sql.literal(LINK_COLUMNS);

  // Only `origin` is rewritten on conflict: `created_at` is when this thread started on this
  // issue, and a second link is the same fact restated, not a new one.
  const linkIssueThreadRow = SqlSchema.void({
    Request: IssueThreadLink,
    execute: (row) =>
      sql`
        INSERT INTO issue_thread_links (
          issue_id,
          thread_id,
          origin,
          created_at
        )
        VALUES (
          ${row.issueId},
          ${row.threadId},
          ${row.origin},
          ${row.createdAt}
        )
        ON CONFLICT (issue_id, thread_id)
        DO UPDATE SET origin = excluded.origin
      `,
  });

  const unlinkIssueThreadRow = SqlSchema.void({
    Request: UnlinkIssueThreadInput,
    execute: ({ issueId, threadId }) =>
      sql`
        DELETE FROM issue_thread_links
        WHERE issue_id = ${issueId} AND thread_id = ${threadId}
      `,
  });

  const listIssueThreadLinkRowsByIssue = SqlSchema.findAll({
    Request: ListIssueThreadLinksByIssueInput,
    Result: IssueThreadLink,
    execute: ({ issueId }) =>
      sql`
        SELECT ${linkColumns}
        FROM issue_thread_links
        WHERE issue_id = ${issueId}
        ORDER BY created_at ASC, thread_id ASC
      `,
  });

  const listIssueThreadLinkRowsByThread = SqlSchema.findAll({
    Request: ListIssueThreadLinksByThreadInput,
    Result: IssueThreadLink,
    execute: ({ threadId }) =>
      sql`
        SELECT ${linkColumns}
        FROM issue_thread_links
        WHERE thread_id = ${threadId}
        ORDER BY created_at ASC, issue_id ASC
      `,
  });

  const link: IssueThreadLinkRepositoryShape["link"] = (row) =>
    linkIssueThreadRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueThreadLinkRepository.link:query",
          "IssueThreadLinkRepository.link:encodeRequest",
        ),
      ),
    );

  const unlink: IssueThreadLinkRepositoryShape["unlink"] = (input) =>
    unlinkIssueThreadRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueThreadLinkRepository.unlink:query",
          "IssueThreadLinkRepository.unlink:encodeRequest",
        ),
      ),
    );

  const listByIssue: IssueThreadLinkRepositoryShape["listByIssue"] = (input) =>
    listIssueThreadLinkRowsByIssue(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueThreadLinkRepository.listByIssue:query",
          "IssueThreadLinkRepository.listByIssue:decodeRows",
        ),
      ),
    );

  const listByThread: IssueThreadLinkRepositoryShape["listByThread"] = (input) =>
    listIssueThreadLinkRowsByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueThreadLinkRepository.listByThread:query",
          "IssueThreadLinkRepository.listByThread:decodeRows",
        ),
      ),
    );

  return {
    link,
    unlink,
    listByIssue,
    listByThread,
  } satisfies IssueThreadLinkRepositoryShape;
});

export const IssueThreadLinkRepositoryLive = Layer.effect(
  IssueThreadLinkRepository,
  makeIssueThreadLinkRepository,
);
