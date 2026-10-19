# Concurrent agent time adds to project totals

Status: implemented in source; focused verification and deployment boundaries are recorded in the implementation plan.
Date: 2026-09-08.

## Context

The existing tracker permits one manual timer per account. Corey regularly runs eight agents concurrently on one project and requires every agent's work to be recorded. A single automatic project timer would undercount that work.

## Decision

Record concurrent agent activity independently and add each duration to the project total. Preserve the overlap and show elapsed activity as a separate metric.

Eight agents working concurrently for 30 minutes produce eight tracked sessions, four hours of agent work, and 30 minutes of elapsed activity.

The existing restriction on concurrent manual timers must not prevent automatic agent sessions. This decision does not change manual timer concurrency or settle how nested child agents count.

Pause an agent's timer when it is blocked waiting for a permission or answer, and resume when work continues. Exclude that blocked interval from its recorded work duration. An unanswered non-blocking question does not pause time while the agent continues working.

Credit successful human issue creation with the greater of one minute or active composer time. Exclude idle time. Preserve measured intervals separately from minimum credit so analytics does not invent elapsed activity.

## Consequences

Project agent work can exceed the hours in a day. Analytics must label summed work and elapsed activity clearly. The global tracker dropdown must accommodate several concurrent activities on the same project.

The environment records durable run intervals and publishes account-private snapshots through its existing cloud identity. Run records currently lack the initiating member, so ownership uses the member who registered the environment. Project grouping uses the cloud project bound to the local project.

See [the implementation record](../../.plans/time-tracking-analytics.md) for the adopted defaults, supported clients, recovery policy, and deployment boundaries.
