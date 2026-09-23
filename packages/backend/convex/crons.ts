import { cronJobs } from "convex/server";

import { internal } from "./_generated/api.js";

const crons = cronJobs();

// Thread deletion schedules its own queue cleanup; these daily passes only catch misses.
crons.daily(
  "prune orphaned delivered thread queues",
  { hourUTC: 4, minuteUTC: 7 },
  internal.threadQueue.pruneOrphans,
  {},
);
crons.daily(
  "prune unused thread queue uploads",
  { hourUTC: 4, minuteUTC: 12 },
  internal.threadQueue.pruneAttachments,
  {},
);

crons.hourly(
  "delete abandoned issue attachment uploads",
  { minuteUTC: 17 },
  internal.issueAttachments.gcPending,
);

crons.hourly(
  "prune sync feed rows past retention",
  { minuteUTC: 47 },
  internal.sync.pruneExpired,
  {},
);

crons.interval(
  "expire overdue environment commands",
  { minutes: 5 },
  internal.environmentCommands.expireOverdueSweep,
  {},
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

crons.daily(
  "mark environment bindings stale when their registration is gone",
  { hourUTC: 3, minuteUTC: 41 },
  internal.cloudProjects.revokeStaleEnvironmentBindings,
  {},
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

// Delegated work refreshes on its own events; this catches misses and event-less inputs.
crons.interval(
  "repair delegated orchestrator work",
  { minutes: 5 },
  internal.aiOrchestratorJobs.repairWork,
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
