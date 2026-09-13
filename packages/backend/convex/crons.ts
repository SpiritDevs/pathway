import { cronJobs } from "convex/server";

import { internal } from "./_generated/api.js";

const crons = cronJobs();

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

crons.hourly("purge expired company assets", { minuteUTC: 37 }, internal.assetStorage.cleanup, {});

crons.interval(
  "release abandoned representation storage",
  { minutes: 5 },
  internal.assetStorage.cleanupRepresentations,
  {},
);

export default crons;
