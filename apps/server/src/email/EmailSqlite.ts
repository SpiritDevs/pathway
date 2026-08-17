import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

import { ServerConfig } from "../config.ts";

type RuntimeSqliteLayerConfig = {
  readonly filename: string;
  readonly spanAttributes?: Record<string, unknown>;
};

type SqliteLoader = {
  readonly layer: (config: RuntimeSqliteLayerConfig) => Layer.Layer<SqlClient.SqlClient, SqlError>;
};

const sqliteLoaders = {
  bun: () => import("@effect/sql-sqlite-bun/SqliteClient"),
  node: () => import("../persistence/NodeSqliteClient.ts"),
} satisfies Record<string, () => Promise<SqliteLoader>>;

const makeRuntimeSqliteLayer = Effect.fn("EmailSqlite.makeRuntimeSqliteLayer")(function* (
  config: RuntimeSqliteLayerConfig,
) {
  const runtime = process.versions.bun === undefined ? "node" : "bun";
  const clientModule = yield* Effect.promise<SqliteLoader>(sqliteLoaders[runtime]);
  return clientModule.layer(config);
}, Layer.unwrap);

const setup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA foreign_keys = ON`;
    yield* sql`PRAGMA journal_mode = WAL`;
    yield* sql`
      CREATE TABLE IF NOT EXISTS email_messages (
        id TEXT PRIMARY KEY,
        project_id TEXT,
        mail_slug TEXT,
        matched_by TEXT NOT NULL,
        matched_value TEXT,
        received_at TEXT NOT NULL,
        stored_at TEXT NOT NULL,
        total_duration_ms INTEGER NOT NULL,
        is_read INTEGER NOT NULL DEFAULT 0,
        raw_relative_path TEXT NOT NULL,
        payload_json TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS email_attachments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
        filename TEXT,
        content_type TEXT NOT NULL,
        content_disposition TEXT,
        content_id TEXT,
        size_bytes INTEGER NOT NULL,
        relative_path TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS email_messages_inbox_received_idx
      ON email_messages(project_id, received_at DESC, id DESC)
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS email_messages_read_idx
      ON email_messages(project_id, is_read, received_at DESC)
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS email_attachments_message_idx
      ON email_attachments(message_id)
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS email_message_addresses (
        message_id TEXT NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK (kind IN ('sender', 'recipient')),
        address TEXT NOT NULL,
        PRIMARY KEY (message_id, kind, address)
      ) STRICT
    `;
    yield* sql`
      CREATE TABLE IF NOT EXISTS email_waits (
        id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        provider_instance_id TEXT NOT NULL,
        criteria_json TEXT NOT NULL,
        delivery TEXT NOT NULL,
        task_id TEXT UNIQUE,
        status TEXT NOT NULL,
        registered_ms INTEGER NOT NULL,
        expires_ms INTEGER NOT NULL,
        completed_ms INTEGER,
        matched_message_id TEXT REFERENCES email_messages(id),
        registration_json TEXT NOT NULL
      )
    `;
    yield* sql`
      CREATE INDEX IF NOT EXISTS email_waits_pending_idx
      ON email_waits(status, expires_ms, registered_ms)
    `;
  }),
);

export const makeMailSqliteLayer = Effect.fn("EmailSqlite.makeMailSqliteLayer")(function* (
  filename: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.dirname(filename), { recursive: true });
  return Layer.provideMerge(
    setup,
    makeRuntimeSqliteLayer({
      filename,
      spanAttributes: {
        "db.name": path.basename(filename),
        "service.name": "pathway-email-capture",
      },
    }),
  );
}, Layer.unwrap);

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    return makeMailSqliteLayer(path.join(config.stateDir, "mail.sqlite"));
  }),
);
