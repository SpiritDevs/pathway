import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Stage 3 of the tracker (decision 0006): saved views.
 *
 * A view is a named chip bar — filter, grouping, sort, and layout — pinned to the sidebar. The
 * whole configuration lands in one JSON column rather than a column per chip: every filter is
 * optional, the set of them will grow with the filter bar, and nothing ever queries a view by one
 * of its filters. What the tracker does query is the order, which is why `position` is a column.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS issue_views (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      position REAL NOT NULL,
      config_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // The sidebar reads every view in order on each render of the tracker, and that is the only
  // read this table has.
  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_issue_views_position
    ON issue_views(position, id)
  `;
});
