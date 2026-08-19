# 0012 — Workspace-owned Slack intake workflows

Status: Accepted
Date: 2026-08-20
Supersedes: [0010](0010-company-integrations-and-durable-automation.md)

## Context

[0010](0010-company-integrations-and-durable-automation.md) made Convex authoritative for
organisation Slack integrations and durable issue automation, while leaving Personal integrations
in one environment's SQLite database. [0011](0011-company-owned-projects.md) subsequently made a
personal workspace a permanent one-member company using the same cloud authority as every other
workspace. Keeping new Personal integrations environment-local would now create two configuration
models, prevent a member from connecting several Slack workspaces, and make the same setup appear
differently on different signed-in devices.

The original channel-watch model also became too small. Intake needs ordered routing across text
prefixes, Slack reactions, bot mentions, and catch-all messages. Each result may choose company- or
team-owned workflow, a project, initial status, investigation timing, and assignment timing. These
choices must remain deterministic across controller failover and later configuration edits.

## Decision

Convex owns every newly created Slack integration, including integrations owned by the member's
Personal workspace. Personal and organisation workspaces use the same credential, watch, ledger,
controller, and automation model. An owner may connect several Slack workspaces.

Existing environment-local Personal integrations are not imported or deleted. They remain visible
in a separate **On this environment — legacy** section and continue to use their local poller. A
cloud-owned integration fences a matching upgraded local watcher so both authorities cannot file
the same message.

The lease, generation fencing, encrypted credential boundary, central Slack ledger, durable
outbound delivery, and durable automation jobs from 0010 remain part of this decision.

### Draft setup and activation

Slack setup is a resumable three-step draft:

1. **Connect Slack** selects the owning Personal or organisation workspace, validates an `xoxb-`
   bot token with Slack, records the discovered Slack workspace identity, and requires at least one
   channel.
2. **Route issues** configures ordered intake rules and their issue placement.
3. **Automate & activate** configures investigation and assignment timing, enables workspace issue
   automation when required, selects a healthy controller, and activates the integration.

A draft may be resumed or deleted. Its token is encrypted as soon as Slack accepts it. The client
never receives plaintext after submission.

Pathway selects the current healthy compatible environment as the initial controller. Ordered
backups remain a later management concern. Activation requires the controller protocol supported by
the saved configuration. A V1 watch continues to run on the V1 contract; a V2 configuration does
not activate on a V1-only controller. Activation is successful after the first healthy poll. If
that poll takes too long, the integration remains active and reports a warning rather than rolling
back to a draft.

### Ordered intake rules

Each watched channel has ordered rules. The first matching rule wins, produces at most one issue,
and stores its configuration revision with the result. A message that matches no rule is ignored.

A rule condition is a recursively nested AND/OR tree whose leaves are:

- case-insensitive text prefixes, matched after leading whitespace;
- a Slack reaction on the message;
- an @-mention of the connected bot; or
- every human message.

A prefix leaf may contain several prefixes. The longest matching prefix is removed from the issue
title. Slack reaction leaves inspect Slack reaction metadata, not emoji text in the message. When an
earlier rule depends on a reaction and a lower rule would otherwise match immediately, Pathway
holds the lower match for 60 seconds so the reaction can arrive. The existing bounded late-reaction
scan remains the recovery path after that window.

Configuration is bounded to 25 rules per channel, 50 condition nodes per rule, 250 condition nodes
per watch, 10 prefixes per leaf, 80 characters per prefix, and 32 KiB of serialized configuration.
The controller compiles a validated condition tree once per configuration revision rather than for
every Slack message.

### Issue placement and durable automation intent

A matching rule chooses company-wide workflow or one team, an optional project and cycle, and an
initial real status or Triage. The issue always belongs to the integration's owning workspace.

Investigation is either off, immediate, or triggered once when the issue enters a selected status.
It may optionally move the issue to another status after a successful investigation. Failure never
applies that success transition.

Assignment is immediate or waits for investigation to reach a terminal result. A blocked or
retrying investigation continues to hold assignment. A successful investigation and a terminally
failed investigation both release it. Investigation and automatic assignment require a project;
configuration prefers a healthy project binding and a ready provider/model and otherwise creates a
visible blocked job.

Issue creation stores an immutable automation-intent snapshot. Status-triggered work is keyed so a
transition schedules it once. Later edits to the watch cannot change already accepted work.

### Future ownership transfer

Ownership transfer is intentionally deferred until the complete atomic backend operation is
available. It must not be exposed as an in-place company ID update or a client-orchestrated series
of mutations. The member must have integration-management permission in both workspaces.

Pathway decrypts and re-encrypts the bot token inside the backend under the destination credential
context. It copies Slack workspace and channel identities plus condition trees, but clears every
team, project, status, cycle, and automation reference because those records are workspace-owned.
The eventual design keeps the source integration active while the destination is a draft. After the
destination has been reviewed and is ready, one atomic cutover disconnects the source, activates
the destination, and starts new cursors.

Existing issues remain in the source workspace and are not migrated. They retain readable Slack
provenance but no longer receive future Slack synchronization through the moved integration.

## Consequences

- Personal integrations follow a signed-in member across devices and can include several Slack
  workspaces.
- Administrators configure connection, routing, and automation as one guided operation rather than
  repairing a partially connected row afterwards.
- Rule evaluation is deterministic, bounded, and portable across controller failover.
- Automation timing survives restarts and configuration edits because intent is recorded with the
  issue.
- A future ownership-transfer flow requires reselecting workspace-owned destinations, but must
  never expose the bot token or move historical issues implicitly.
- Web and Electron share management UI. Mobile management remains out of scope.

## Alternatives rejected

- **Keep Personal integrations local.** It contradicts the permanent Personal workspace model and
  preserves different behavior across signed-in devices.
- **Automatically import legacy local integrations.** Ownership and duplicate-polling choices are
  ambiguous; a visible legacy section is safer.
- **Evaluate every matching rule.** It can create duplicate issues and makes visible rule order
  meaningless.
- **Treat an emoji character as a Slack reaction.** Message text and Slack reaction metadata are
  different user actions.
- **Assign while investigation is blocked.** It violates the configured ordering and makes a
  temporary readiness problem change workflow behavior.
- **Move existing issues with an integration.** Historical issue ownership is a separate,
  destructive company migration and must not be hidden inside credential movement.
