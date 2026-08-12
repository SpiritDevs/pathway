import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * A tracker with no statuses cannot accept an issue, so the workflow ships seeded rather than
 * empty. Ids are slugs rather than generated so a fresh environment and an imported one agree.
 */
const DEFAULT_STATUSES = [
  { id: "backlog", name: "Backlog", color: "#95a2b3", category: "backlog", position: 1 },
  { id: "todo", name: "Todo", color: "#e2e2e2", category: "unstarted", position: 2 },
  { id: "in-progress", name: "In Progress", color: "#f2c94c", category: "started", position: 3 },
  { id: "in-review", name: "In Review", color: "#26b5ce", category: "started", position: 4 },
  { id: "done", name: "Done", color: "#5e6ad2", category: "completed", position: 5 },
  { id: "canceled", name: "Canceled", color: "#95a2b3", category: "canceled", position: 6 },
] as const;

const DEFAULT_KEY_PREFIX = "ISS";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_statuses (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      category TEXT NOT NULL,
      position REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_labels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status_id TEXT NOT NULL,
      priority TEXT NOT NULL DEFAULT 'none',
      assignee_json TEXT,
      project_id TEXT,
      parent_id TEXT,
      sort_order TEXT NOT NULL,
      due_date TEXT,
      triage INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT
    )
  `;

  // The list view reads live rows grouped by status; every other index here serves a sidebar entry.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_issues_live_status
    ON issues(deleted_at, status_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_issues_triage
    ON issues(triage)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_issues_project
    ON issues(project_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_label_assignments (
      issue_id TEXT NOT NULL,
      label_id TEXT NOT NULL,
      PRIMARY KEY (issue_id, label_id)
    )
  `;

  // The primary key already covers issue-first lookups; deleting a label sweeps the other way.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_issue_label_assignments_label
    ON issue_label_assignments(label_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_events (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      actor_json TEXT NOT NULL,
      kind TEXT NOT NULL,
      field TEXT,
      before TEXT,
      after TEXT,
      created_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_issue_events_issue
    ON issue_events(issue_id, created_at)
  `;

  // One prefix and one counter per environment, so `id = 1` is the whole table.
  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_tracker_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      key_prefix TEXT NOT NULL,
      next_number INTEGER NOT NULL
    )
  `;

  yield* sql`
    INSERT OR IGNORE INTO issue_tracker_config (id, key_prefix, next_number)
    VALUES (1, ${DEFAULT_KEY_PREFIX}, 1)
  `;

  const statusCounts = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS "count" FROM issue_statuses
  `;

  if ((statusCounts[0]?.count ?? 0) === 0) {
    const seededAt = DateTime.formatIso(yield* DateTime.now);
    for (const status of DEFAULT_STATUSES) {
      yield* sql`
        INSERT INTO issue_statuses (id, name, color, category, position, created_at, updated_at)
        VALUES (
          ${status.id},
          ${status.name},
          ${status.color},
          ${status.category},
          ${status.position},
          ${seededAt},
          ${seededAt}
        )
      `;
    }
  }
});
