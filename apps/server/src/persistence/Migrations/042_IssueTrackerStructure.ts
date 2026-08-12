import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Stage 2 of the tracker (decision 0006): the planning containers and the per-issue tails.
 *
 * Milestones, cycles, todos, relations, and comments all hang off rows migration 041 created, so
 * this migration only adds tables and the two columns on `issues` that point at the new
 * containers. No foreign keys, matching 041 and the projection tables: the service owns
 * referential integrity because a soft-deleted issue still has to keep its comments.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A milestone belongs to a project. Nothing here enforces that the project exists: projects are
  // soft-deleted, and a milestone under a deleted project has to survive its restore.
  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_milestones (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT,
      target_date TEXT,
      position REAL NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // The sidebar reaches milestones by expanding one project, which is this index exactly.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_issue_milestones_project
    ON issue_milestones(project_id, position)
  `;

  // Only the dates are stored: upcoming/active/ended is a function of today, and a stored copy of
  // that would be stale the moment this server slept. `completed_at` is the finalisation stamp.
  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_cycles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // Carry-over reads "ended and not finalised, in date order" on every snapshot, so it gets an
  // index rather than a table scan on a server that wakes up months later.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_issue_cycles_end
    ON issue_cycles(completed_at, end_date)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_todos (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      position REAL NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_issue_todos_issue
    ON issue_todos(issue_id, position)
  `;

  // One row per pair. "Blocked by" is `blocks` read from the other end rather than a second row,
  // so the unique key is the whole directed triple and the service reads it from both sides.
  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_relations (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      related_issue_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      UNIQUE (issue_id, related_issue_id, kind)
    )
  `;

  // The unique key covers the outgoing read; the inbound half needs its own index.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_issue_relations_related
    ON issue_relations(related_issue_id)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_comments (
      id TEXT PRIMARY KEY,
      issue_id TEXT NOT NULL,
      author_json TEXT NOT NULL,
      body TEXT NOT NULL,
      attachment_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      edited_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_issue_comments_issue
    ON issue_comments(issue_id, created_at)
  `;

  const issueColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(issues)
  `;

  if (!issueColumns.some((column) => column.name === "milestone_id")) {
    yield* sql`
      ALTER TABLE issues
      ADD COLUMN milestone_id TEXT
    `;
  }

  if (!issueColumns.some((column) => column.name === "cycle_id")) {
    yield* sql`
      ALTER TABLE issues
      ADD COLUMN cycle_id TEXT
    `;
  }

  // Deleting a milestone and carrying a cycle over both sweep `issues` by one of these columns.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_issues_milestone
    ON issues(milestone_id)
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_issues_cycle
    ON issues(cycle_id)
  `;
});
