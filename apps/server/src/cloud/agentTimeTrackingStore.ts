import { OrchestrationV2DomainEventJson } from "@spiritdevs/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AgentTimeSession,
  applyAgentTimeEvent,
  transitionAgentTimeSession,
} from "./agentTimeTracking.ts";

const decodeSession = Schema.decodeUnknownSync(Schema.fromJsonString(AgentTimeSession));
const encodeSession = Schema.encodeSync(Schema.fromJsonString(AgentTimeSession));
const decodeEvent = Schema.decodeUnknownEffect(OrchestrationV2DomainEventJson);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

/** A durable projection doubles as an outbox: acknowledgements never remove the captured time. */
export const makeAgentTimeTrackingStore = Effect.fn("AgentTimeTrackingStore.make")(function* (
  companyId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const save = Effect.fn("AgentTimeTrackingStore.save")(function* (session: AgentTimeSession) {
    yield* sql`INSERT INTO agent_time_tracking_sessions
      (company_id, run_id, thread_id, state, payload_json, dirty)
      VALUES (${companyId}, ${session.id}, ${session.threadId}, ${session.state}, ${encodeSession(session)}, 1)
      ON CONFLICT(company_id, run_id) DO UPDATE SET state = excluded.state,
        payload_json = excluded.payload_json, dirty = 1`;
  });

  const priorCursors = yield* sql<{ sequence: number }>`SELECT sequence
    FROM agent_time_tracking_cursors WHERE company_id = ${companyId}`;
  // The first enablement starts at the current event boundary, never backfills historical runs.
  yield* sql`INSERT OR IGNORE INTO agent_time_tracking_cursors(company_id, sequence)
    SELECT ${companyId}, COALESCE(MAX(sequence), 0) FROM orchestration_events`;

  const capture = Effect.fn("AgentTimeTrackingStore.capture")(function* () {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const cursors = yield* sql<{
          sequence: number;
        }>`SELECT sequence FROM agent_time_tracking_cursors
        WHERE company_id = ${companyId}`;
        const after = cursors[0]!.sequence;
        const boundaries = yield* sql<{
          sequence: number;
        }>`SELECT COALESCE(MAX(sequence), 0) AS sequence
        FROM orchestration_events`;
        const through = boundaries[0]!.sequence;
        const rows = yield* sql<{
          sequence: number;
          event_id: string;
          command_id: string | null;
          stream_id: string;
          event_type: string;
          occurred_at: string;
          payload_json: string;
          run_id: string | null;
        }>`SELECT sequence, event_id, command_id, stream_id, event_type, occurred_at, payload_json,
          json_extract(metadata_json, '$.runId') AS run_id
        FROM orchestration_events WHERE sequence > ${after} AND sequence <= ${through} AND application_event_version = 2
          AND event_type IN ('run.created', 'run.updated', 'runtime-request.updated', 'thread.deleted')
        ORDER BY sequence LIMIT 500`;
        for (const row of rows) {
          const event = yield* decodeEvent({
            id: row.event_id,
            threadId: row.stream_id,
            type: row.event_type,
            occurredAt: row.occurred_at,
            payload: yield* decodeJson(row.payload_json),
            ...(row.run_id === null ? {} : { runId: row.run_id }),
          });
          const runId =
            event.type === "run.created" || event.type === "run.updated"
              ? event.payload.id
              : (event.runId ?? null);
          const sessions = yield* sql<{ payload_json: string }>`SELECT payload_json
          FROM agent_time_tracking_sessions WHERE company_id = ${companyId}
            AND thread_id = ${row.stream_id} AND (${runId} IS NULL OR run_id = ${runId})
            AND (${event.type === "run.created" || event.type === "run.updated" ? 1 : 0} = 1 OR state != 'stopped')`;
          if (sessions.length === 0 && event.type === "run.created") {
            const projects = yield* sql<{ project_id: string; title: string }>`SELECT
              json_extract(payload_json, '$.projectId') AS project_id,
              json_extract(payload_json, '$.title') AS title
            FROM orchestration_events WHERE stream_id = ${row.stream_id}
              AND sequence <= ${row.sequence} AND application_event_version = 2
              AND event_type LIKE 'thread.%' AND json_extract(payload_json, '$.projectId') IS NOT NULL
              AND COALESCE(json_extract(payload_json, '$.lineage.relationshipToParent'), '') != 'subagent'
              ORDER BY sequence DESC LIMIT 1`;
            const project = projects[0];
            if (project) {
              const next = applyAgentTimeEvent(null, event, {
                id: project.project_id,
                title: project.title,
              });
              if (next) yield* save(next);
            }
          } else {
            for (const stored of sessions) {
              const session = decodeSession(stored.payload_json);
              // Startup recovery timestamps describe when the old process was discovered dead,
              // not when its provider stopped working. The persisted command identity comes from
              // ProviderRuntimeRecoveryService; ordinary completions and shutdown keep their time.
              const timedEvent = row.command_id?.startsWith("command:runtime-reconcile:startup:")
                ? { ...event, occurredAt: DateTime.makeUnsafe(session.observedAt) }
                : event;
              const next = applyAgentTimeEvent(session, timedEvent, {
                id: session.localProjectId,
                title: session.description,
              });
              if (next !== null && next !== session) yield* save(next);
            }
          }
        }
        if (through > after) {
          yield* sql`UPDATE agent_time_tracking_cursors SET sequence = ${rows.length === 500 ? rows.at(-1)!.sequence : through}
          WHERE company_id = ${companyId}`;
        }
        return rows.length === 500;
      }),
    );
  });

  if (priorCursors.length > 0) {
    // Replay committed completions before capping clocks left open by a process crash. Otherwise
    // work completed while cloud delivery was offline would be cut back to an old heartbeat.
    while (yield* capture()) {
      /* drain persisted lifecycle events */
    }
    const interrupted = yield* sql<{ payload_json: string }>`SELECT payload_json
      FROM agent_time_tracking_sessions WHERE company_id = ${companyId} AND state = 'running'`;
    for (const row of interrupted) {
      const session = decodeSession(row.payload_json);
      yield* save(
        transitionAgentTimeSession(
          { ...session, runStatus: "waiting" },
          "paused",
          session.observedAt,
        ),
      );
    }
  }

  const pending = Effect.fn("AgentTimeTrackingStore.pending")(function* (now: number) {
    // Keep the local crash boundary current even while a project's cloud binding is unavailable.
    yield* sql`UPDATE agent_time_tracking_sessions SET payload_json = json_set(payload_json,
        '$.observedAt', MAX(${now}, json_extract(payload_json, '$.observedAt')),
        '$.revision', json_extract(payload_json, '$.revision') + 1)
      WHERE company_id = ${companyId} AND state = 'running'`;
    const rows = yield* sql<{ payload_json: string }>`SELECT payload_json
      FROM agent_time_tracking_sessions WHERE company_id = ${companyId}
        AND next_attempt_at <= ${now} AND (dirty = 1 OR state = 'running')
        ORDER BY last_attempt_at, run_id LIMIT 500`;
    const sessions: AgentTimeSession[] = [];
    for (const row of rows) {
      const session = decodeSession(row.payload_json);
      yield* sql`UPDATE agent_time_tracking_sessions SET last_attempt_at = ${now}
        WHERE company_id = ${companyId} AND run_id = ${session.id}`;
      sessions.push(session);
    }
    return sessions;
  });

  const acknowledge = (session: AgentTimeSession) =>
    sql`UPDATE agent_time_tracking_sessions
    SET dirty = 0 WHERE company_id = ${companyId} AND run_id = ${session.id}
      AND payload_json = ${encodeSession(session)}`.pipe(Effect.asVoid);

  const deferUnbound = (session: AgentTimeSession, now: number) =>
    sql`UPDATE agent_time_tracking_sessions SET next_attempt_at = ${now + 5 * 60_000}
      WHERE company_id = ${companyId} AND run_id = ${session.id}`.pipe(Effect.asVoid);

  return { capture, pending, acknowledge, deferUnbound };
});
