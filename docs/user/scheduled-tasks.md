# Scheduled tasks

A scheduled task runs a prompt for you without anyone typing it. Manage them in
**Settings → Schedule Tasks**. Each task belongs to a project and uses the model
and workspace you choose; it can post into an existing thread or start a fresh
thread for every run. A task runs on its environment, so the environment must be
online.

A task runs on one of three triggers:

- **Daily**: at a time of day, on the weekdays you pick, in the environment's
  time zone.
- **Interval**: every so many minutes.
- **Webhook**: whenever another service calls the task's URL.

You can edit, pause, resume, or delete a task from the list. Daily and interval
tasks can also be run immediately. Webhook tasks only run when their URL is
called, so they can't be run immediately.

## Webhook automations

Choose **Webhook** as the task's schedule to run it whenever another service
calls its URL, such as GitHub on a new pull request or a CI job that failed.
After you save the task, copy its URL from the editor.

- If the environment has a Pathway Connect managed tunnel, the URL is public and
  any service on the internet can call it.
- Otherwise the URL uses the address your device reaches the environment at. It
  works wherever that address is reachable, for example over Tailscale or your
  own proxy. An address like `127.0.0.1` only works on that computer.

The URL contains a secret. Anyone who has it can start a run, so share it only
with the service that needs it. **Rotate** replaces the URL and the old one stops
working at once. Saving the task never changes its URL.

The prompt decides what the agent sees. Placeholders pull values out of the
request: `{{body.path}}` for a JSON or form field, `{{headers.name}}`,
`{{query.name}}`, `{{body}}` for the raw body, and `{{request}}` for everything.
For example, `Review this PR: {{body.pull_request.html_url}}` sends only the
pull request link. A placeholder with no value is left empty. New webhook tasks
start with `Handle this webhook:` followed by `{{body}}`. Credentials such as
`Authorization` headers, cookies, and `token` or `key` query values are hidden
when `{{request}}`, `{{headers}}`, or `{{query}}` renders the whole set; name one
directly, such as `{{headers.authorization}}`, if the agent really needs it.

For GitHub, turn on **Require signature**, keep the header
`x-hub-signature-256`, hex encoding and the `sha256=` prefix, and enter the
same secret in the repository's webhook settings with content type
`application/json`. Requests without a valid signature are rejected. The secret
is never shown again; leave the field empty when editing to keep it.

Requests to one task run one after another, in the order they arrived. To skip
requests that waited too long behind earlier runs, set **Skip requests older
than** on the task. Each task accepts up to 60 requests a minute and holds up to
20 waiting requests; bodies are limited to 1 MB.

Choose **Deliveries** next to a webhook task to see its last 50 requests, what
happened to each, and the prompt each one produced. Deleting the task deletes
its deliveries.

A request that is waiting its turn shows as **Waiting**. If Pathway stops
before it runs, it runs when Pathway starts again.

If the environment is offline, the sender gets an error and nothing runs;
redeliver from the sender, such as GitHub's **Recent Deliveries**, once it is
back. The sender's response includes an `x-pathway-hook-outcome` header naming
what happened, such as `accepted`, `rejected_signature`, or `rate_limited`.

Agents can create webhook tasks too, and report the URL back to you. Create
webhook tasks and change their trigger on desktop or web. The iOS app can edit
a webhook task's other settings.
