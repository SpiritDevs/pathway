import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("keeps legacy cloud auth records without assigning the current owner's identity", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 77 });
    yield* sql`
      INSERT INTO auth_pairing_links (
        id, credential, method, scopes, subject, created_at, expires_at
      ) VALUES (
        'old-grant', 'old-credential', 'one-time-token', '[]', 'cloud-connect',
        '2026-09-29T00:00:00.000Z', '2026-09-29T01:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO auth_sessions (
        session_id, subject, scopes, method, issued_at, expires_at
      ) VALUES (
        'old-session', 'cloud-connect', '[]', 'bearer-access-token',
        '2026-09-29T00:00:00.000Z', '2026-09-29T01:00:00.000Z'
      )
    `;
    yield* runMigrations({ toMigrationInclusive: 78 });
    expect(yield* sql`SELECT id, clerk_subject FROM auth_pairing_links`).toEqual([
      { id: "old-grant", clerk_subject: null },
    ]);
    expect(yield* sql`SELECT session_id, clerk_subject FROM auth_sessions`).toEqual([
      { session_id: "old-session", clerk_subject: null },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
