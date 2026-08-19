# Integrations

Open **Settings → Integrations** to connect Slack intake and manage issue automation. The former
**Triage & Intake** address redirects here, including links to its Slack and automation sections.

## Add a Slack workspace

Choose **Add integration** to open a three-step setup. You can leave before activation and resume
the draft later, or delete it if you no longer need it.

### 1. Connect Slack

Choose the Pathway workspace that owns the integration: your Personal workspace or an organisation
you can manage. This choice controls where new issues and integration settings are stored; it does
not limit Slack to one Pathway environment. Personal and organisation workspaces can each connect
several Slack workspaces.

Enter the Slack bot token. Pathway validates it with Slack, shows the discovered Slack workspace
name and ID, encrypts it, and never displays it again. Choose at least one channel for the bot to
watch. The channel picker only shows channels the bot can see, so invite the bot to a missing
channel in Slack and refresh the list.

### 2. Route issues

Each watched channel has an ordered list of rules. The first matching rule creates one issue; if no
rule matches, Pathway ignores the message.

A rule can match:

- one of several text prefixes at the start of a message;
- a Slack reaction added to the message;
- an @-mention of the connected bot;
- every human message; or
- a nested combination using **all** and **any** groups.

Prefix matching ignores case and leading whitespace. If several configured prefixes match, Pathway
uses and removes the longest one from the generated issue title. Reaction rules use Slack's actual
reaction on the message, not an emoji typed into its text.

Rules that depend on a reaction get a short grace period before a lower catch-all rule can win.
This lets somebody react after posting without creating the fallback issue first. Pathway also
checks a bounded recent window for reactions added later.

For each result, choose whether the issue uses company-wide workflow or belongs to one team. You
can also choose its project, release cycle, and initial placement. Select a real status to put the
issue straight into the workflow, or choose **Triage** to leave it for review.

### 3. Automate and activate

Investigation can be:

- **Off**;
- **Immediately after intake**; or
- **When the issue reaches a status** you choose.

After a successful investigation, Pathway can optionally move the issue to another status. A
failed investigation never applies that success status.

Automatic assignment can run immediately or wait for investigation to finish. When it waits,
blocked and retrying investigations continue to hold assignment. A successful investigation or a
terminally failed investigation releases it. Investigation and assignment need a project with a
healthy environment connection and a ready provider/model. If one becomes unavailable, the work
remains visible as blocked rather than silently choosing a different target.

Pathway enables issue automation for the owning workspace when the setup needs it and you have
permission. It selects the current healthy compatible environment as the initial Slack controller.
Activation completes after that controller's first healthy poll. If the first poll takes longer
than expected, the integration stays active and shows a warning you can retry from its health view.

## Controllers and failover

Only one compatible environment polls a Slack workspace at a time. If it disappears, its lease
expires after about 90 seconds and the first healthy configured backup takes over from the shared
cursor. A returning preferred environment reports healthy twice, then regains control at a lease
boundary. Pathway never round-robins or selects an environment outside the configured controller
list.

The first channel watch starts from the time it is activated. Failover resumes its central cursor
rather than replaying the channel. Message origins are deduplicated centrally, including replies.
If a Slack send times out ambiguously, Pathway looks for its delivery marker before retrying.

## Manage an integration

Select a Slack workspace row to review its owner, channels, routing, automation, controller health,
and recent jobs. Members with integration read access can see redacted configuration and health.
Changing anything requires integration management access.

Disconnecting removes the encrypted credential but retains routing, cursors, controller order, and
health so the same Slack workspace can be reconnected. Permanently removing an integration deletes
its credential and operational records. Existing issues stay readable.

## Issue automation

The separate **Issue automation** row opens workspace routing, audit, transition, reviewer, and
remediation settings. Slack rules can enable this authority during activation. Pausing it later does
not silently fall back to environment-local automation.

Every automatic action is a durable job. Recent jobs show their state, target environment, attempts,
and reason. A job may be pending, blocked, claimed, running, succeeded, failed, or canceled. Missing
project bindings, offline environments, disabled providers, and unavailable models block visibly.
Administrators can retry blocked or failed jobs and cancel unfinished jobs.

Transient failures retry at increasing intervals before becoming failed. A final failure adds one
comment to the issue; retries and readiness changes do not spam its conversation.

## Legacy integrations and issues

Slack integrations created in a Personal workspace before cloud-owned integrations remain on the
environment where they were configured. They appear under **On this environment — legacy** and are
not imported automatically. This keeps their token and cursor ownership unambiguous. You may keep
managing them locally or create a new cloud-owned integration when you are ready.

Slack issues created before cloud integrations do not contain a Slack integration/workspace ID.
They remain readable and show **Legacy Slack link—two-way replies unavailable**. Pathway does not
guess which workspace owns them, so they do not resume Slack synchronization.
