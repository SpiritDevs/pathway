import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const DEFAULT_STATUSES = [
  { id: "backlog", name: "Backlog", color: "#95a2b3", category: "backlog", position: 1 },
  { id: "todo", name: "Todo", color: "#e2e2e2", category: "unstarted", position: 2 },
  { id: "in-progress", name: "In Progress", color: "#f2c94c", category: "started", position: 3 },
  { id: "in-review", name: "In Review", color: "#26b5ce", category: "started", position: 4 },
  { id: "done", name: "Done", color: "#5e6ad2", category: "completed", position: 5 },
  { id: "canceled", name: "Canceled", color: "#95a2b3", category: "canceled", position: 6 },
] as const;

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const statusCounts = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS "count" FROM issue_statuses
  `;

  // Repair databases that passed migration 041 while its seed was absent. Any existing row means
  // the user has a workflow already, including a deliberately minimal or fully custom one.
  if ((statusCounts[0]?.count ?? 0) !== 0) return;

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
});
