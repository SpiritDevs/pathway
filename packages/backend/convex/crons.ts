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

export default crons;
