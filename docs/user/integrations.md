# Integrations

Open **Settings → Integrations** to manage Slack intake and issue automation. The former **Triage &
Intake** address redirects here, including links to its Slack and automation sections.

## Personal workspaces

A personal workspace connects one Slack workspace to the environment you are using. Its token,
watched channels, cursors, and automation settings remain local to that environment. This is the
same behavior Pathway used before the Integrations page moved.

## Organisation workspaces

An organisation may connect several Slack workspaces. Configuration belongs to the company, so
every administrator sees the same workspaces, watched channels, routing, controller priority,
health, and automation jobs.

Select a Slack row to open its floating settings sheet. The sheet contains:

- **Overview** for connection state, activation, and credential replacement.
- **Watched channels** for triggers, reaction routes, project/cycle routing, investigation, and
  assignment.
- **Controller priority** for one preferred environment and ordered backups.
- **Health** for the current controller, lease generation, last poll, and first actionable error.
- **Danger zone** for disconnecting or permanently removing the integration.

Members with `integrations.read` can see redacted configuration and health. Changing anything
requires `integrations.manage`; Slack tokens are never displayed after submission.

### Controllers and failover

Only one environment polls a Slack workspace. If it disappears, its lease expires after about 90
seconds and the first healthy configured backup takes over from the shared cursor. A returning
preferred environment must report healthy twice, then regains control at a lease boundary. Pathway
does not round-robin and never selects an environment outside the configured list.

The first channel watch starts from the time it is added. Failover resumes its central cursor rather
than replaying the channel. Message origins are deduplicated centrally, including replies. An
ambiguous Slack send is reconciled from opaque Slack message metadata before Pathway retries it.

### Connecting and migration

Organisation settings are not imported from individual environments. Configure the company Slack
workspace again, choose its controller order, and review its channels. Activation remains blocked
until the selected environments are upgraded and capability-compatible, the preferred environment
is healthy, and an administrator confirms older watchers have been upgraded/disconnected or their
old token was rotated.

Once active, organisation-local watches for that Slack workspace remain stored but are inert.
Disconnecting the company integration does not silently resume them; that avoids duplicate intake.

Tokens are validated with Slack and encrypted before Convex stores them. A controller receives a
decrypted token only while it holds the current lease, keeps it in memory, and never writes it to
disk. Disconnecting deletes the encrypted credential but retains watches, cursors, controller order,
and health history. Reconnecting must authenticate the same Slack workspace.

Removing an integration requires typing its workspace name. It permanently deletes the credential,
watches, controller pool, cursors, deduplication records, and delivery records. Existing issues stay
readable.

## Issue automation

The separate **Issue automation** row opens the company routing, audit, transition, reviewer, and
remediation settings. Organisation automation is activated independently from Slack.
After its first activation, pausing company automation keeps legacy environment-local automation
inert; it does not silently fall back to a second authority.

Every automatic action is a durable job. Recent jobs show their state, target environment, attempts,
and reason. A job may be pending, blocked, claimed, running, succeeded, failed, or canceled. Missing
project bindings, offline thread environments, missing or disabled provider instances, and
unavailable models block visibly; Pathway never silently chooses another model. Administrators may
retry blocked or failed jobs and cancel unfinished jobs.

Transient failures retry at increasing intervals before becoming failed. A final failure adds one
comment to the issue; retries and readiness changes do not spam its conversation.

## Legacy Slack issues

Slack issues created before company integrations do not contain a Slack integration/workspace ID.
They remain readable and show **Legacy Slack link—two-way replies unavailable**. Pathway does not
guess which workspace owns them, so they do not resume Slack synchronisation.
