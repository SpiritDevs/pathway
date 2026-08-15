import { cronJobs } from "convex/server";

import { internal } from "./_generated/api.js";

const crons = cronJobs();

crons.hourly(
  "delete abandoned issue attachment uploads",
  { minuteUTC: 17 },
  internal.issueAttachments.gcPending,
);

export default crons;
