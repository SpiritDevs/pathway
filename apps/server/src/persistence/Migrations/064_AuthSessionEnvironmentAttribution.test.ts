import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect(
  "adds nullable initiating-environment attribution without invalidating auth records",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 63 });

      yield* sql`
      INSERT INTO auth_pairing_links (
        id, credential, method, scopes, subject, created_at, expires_at
      ) VALUES (
        'link-existing', 'credential-existing', 'one-time-token', '[]', 'existing-user',
        '2026-08-15T00:00:00.000Z', '2026-08-15T01:00:00.000Z'
      )
    `;
      yield* sql`
      INSERT INTO auth_sessions (
        session_id, subject, scopes, method, issued_at, expires_at
      ) VALUES (
        'session-existing', 'existing-user', '[]', 'bearer-access-token',
        '2026-08-15T00:00:00.000Z', '2026-08-15T01:00:00.000Z'
      )
    `;

      yield* runMigrations({ toMigrationInclusive: 64 });

      const pairing = yield* sql<{
        readonly id: string;
        readonly initiatingEnvironmentId: string | null;
      }>`
      SELECT id, initiating_environment_id AS "initiatingEnvironmentId"
      FROM auth_pairing_links
    `;
      const sessions = yield* sql<{
        readonly sessionId: string;
        readonly initiatingEnvironmentId: string | null;
      }>`
      SELECT session_id AS "sessionId", initiating_environment_id AS "initiatingEnvironmentId"
      FROM auth_sessions
    `;

      assert.deepStrictEqual(pairing, [{ id: "link-existing", initiatingEnvironmentId: null }]);
      assert.deepStrictEqual(sessions, [
        { sessionId: "session-existing", initiatingEnvironmentId: null },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
