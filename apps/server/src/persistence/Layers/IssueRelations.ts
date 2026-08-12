import { IssueRelation, type IssueRelationEdge } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  DeleteIssueRelationInput,
  GetIssueRelationInput,
  IssueRelationRepository,
  type IssueRelationRepositoryShape,
  ListIssueRelationsInput,
} from "../Services/IssueRelations.ts";

const RELATION_COLUMNS = `
  id,
  issue_id AS "issueId",
  related_issue_id AS "relatedIssueId",
  kind
`;

const makeIssueRelationRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const relationColumns = sql.literal(RELATION_COLUMNS);

  const insertIssueRelationRow = SqlSchema.void({
    Request: IssueRelation,
    execute: (row) =>
      sql`
        INSERT OR IGNORE INTO issue_relations (
          id,
          issue_id,
          related_issue_id,
          kind
        )
        VALUES (
          ${row.id},
          ${row.issueId},
          ${row.relatedIssueId},
          ${row.kind}
        )
      `,
  });

  const listOutgoingIssueRelationRows = SqlSchema.findAll({
    Request: ListIssueRelationsInput,
    Result: IssueRelation,
    execute: ({ issueId }) =>
      sql`
        SELECT ${relationColumns}
        FROM issue_relations
        WHERE issue_id = ${issueId}
        ORDER BY kind ASC, related_issue_id ASC, id ASC
      `,
  });

  const listIncomingIssueRelationRows = SqlSchema.findAll({
    Request: ListIssueRelationsInput,
    Result: IssueRelation,
    execute: ({ issueId }) =>
      sql`
        SELECT ${relationColumns}
        FROM issue_relations
        WHERE related_issue_id = ${issueId}
        ORDER BY kind ASC, issue_id ASC, id ASC
      `,
  });

  const getIssueRelationRow = SqlSchema.findOneOption({
    Request: GetIssueRelationInput,
    Result: IssueRelation,
    execute: ({ relationId }) =>
      sql`
        SELECT ${relationColumns}
        FROM issue_relations
        WHERE id = ${relationId}
      `,
  });

  const deleteIssueRelationRow = SqlSchema.void({
    Request: DeleteIssueRelationInput,
    execute: ({ relationId }) =>
      sql`
        DELETE FROM issue_relations
        WHERE id = ${relationId}
      `,
  });

  const listByIssue: IssueRelationRepositoryShape["listByIssue"] = (input) =>
    Effect.all([listOutgoingIssueRelationRows(input), listIncomingIssueRelationRows(input)]).pipe(
      Effect.map(
        ([outgoing, incoming]): ReadonlyArray<IssueRelationEdge> => [
          ...outgoing.map((relation) => ({ relation, direction: "outgoing" as const })),
          ...incoming.map((relation) => ({ relation, direction: "incoming" as const })),
        ],
      ),
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueRelationRepository.listByIssue:query",
          "IssueRelationRepository.listByIssue:decodeRows",
        ),
      ),
    );

  const getById: IssueRelationRepositoryShape["getById"] = (input) =>
    getIssueRelationRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueRelationRepository.getById:query",
          "IssueRelationRepository.getById:decodeRow",
        ),
      ),
    );

  const insert: IssueRelationRepositoryShape["insert"] = (row) =>
    insertIssueRelationRow(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueRelationRepository.insert:query",
          "IssueRelationRepository.insert:encodeRequest",
        ),
      ),
    );

  const deleteById: IssueRelationRepositoryShape["deleteById"] = (input) =>
    deleteIssueRelationRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "IssueRelationRepository.deleteById:query",
          "IssueRelationRepository.deleteById:encodeRequest",
        ),
      ),
    );

  return {
    listByIssue,
    getById,
    insert,
    deleteById,
  } satisfies IssueRelationRepositoryShape;
});

export const IssueRelationRepositoryLive = Layer.effect(
  IssueRelationRepository,
  makeIssueRelationRepository,
);
