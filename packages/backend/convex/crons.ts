import { cronJobs } from "convex/server";

import { internal } from "./_generated/api.js";

const crons = cronJobs();

crons.hourly(
  "prune orphaned delivered thread queues",
  { minuteUTC: 7 },
  internal.threadQueue.pruneOrphans,
  {},
);
crons.hourly(
  "prune unused thread queue uploads",
  { minuteUTC: 12 },
  internal.threadQueue.pruneAttachments,
  {},
);

crons.hourly(
  "delete abandoned issue attachment uploads",
  { minuteUTC: 17 },
  internal.issueAttachments.gcPending,
);

crons.daily(
  "prune completed issue automation jobs",
  { hourUTC: 3, minuteUTC: 23 },
  internal.issueAutomation.pruneCompleted,
);

crons.interval(
  "recover blocked issue automation jobs",
  { minutes: 1 },
  internal.issueAutomation.recoverBlocked,
  {},
);

crons.hourly(
  "mark environment bindings stale when their registration is gone",
  { minuteUTC: 41 },
  internal.cloudProjects.revokeStaleEnvironmentBindings,
);

crons.interval(
  "prune expired Focus notifications",
  { minutes: 1 },
  internal.focusNotifications.pruneExpired,
  {},
);

crons.hourly(
  "prune delivered login reports",
  { minuteUTC: 29 },
  internal.loginErrorReports.pruneSent,
);

crons.interval(
  "review orchestrator responsibilities",
  { minutes: 1 },
  internal.aiOrchestratorReviews.wakeDue,
  {},
);

crons.interval(
  "observe orchestrator environment availability",
  { minutes: 1 },
  internal.aiOrchestratorEvents.checkOffline,
  {},
);

crons.interval(
  "prune unused orchestrator attachments",
  { hours: 1 },
  internal.aiOrchestratorAttachments.prune,
  {},
);

crons.interval(
  "backfill conversation attention",
  { minutes: 1 },
  internal.aiOrchestrators.backfillAttention,
  {},
);

export default crons;
