# Webhook tasks

A webhook task is a scheduled task with `schedule.type === "webhook"`. It never
has a `nextRunAt`; it runs when `/api/hooks/:taskId/:token` receives a request.
Ported from t3code (pingdotgg/t3code #15085, #15088, #16232, parts of #15487)
without the relay forwarding or offline hold.

## Flow

1. `scheduledTasks/webhookRoute.ts` handles POST, PUT, PATCH and GET on the
   unauthenticated `webhooks` group of `EnvironmentHttpApi`. It reads the raw
   body (1 MiB cap, enforced on `content-length` and on the reader for chunked
   bodies) and calls `ScheduledTaskService.triggerWebhook`.
2. The service checks the token (constant time; an unknown task and a wrong
   token both answer 404), the per-task rate limit (60 a minute, sliding), the
   enabled flag, and the optional HMAC-SHA256 signature over the exact bytes.
3. It renders the prompt (`webhookTemplate.ts`), refuses prompts over
   `PROVIDER_SEND_TURN_MAX_INPUT_CHARS`, takes one of 20 per-task queue slots,
   logs the delivery as `queued` with its whole rendered prompt, and answers
   202 before the run starts.
4. A forked fiber waits on the task's semaphore, so deliveries for one task
   dispatch in arrival order through the ordinary `runTask` path
   (`ThreadLaunchService.launch` or `ThreadManagementService.sendToThread`,
   as the server, with allowance inheritance). The fire key is
   `taskId:webhook:deliveryId`, so a delivery cannot dispatch twice. A queued
   delivery is skipped if the task was paused, replaced, switched to another
   trigger, or waited past `maxDeliveryAgeMinutes` (measured from when this
   environment received it; outcome `expired`). A delivery becomes `accepted`
   once its run starts.
5. On startup the service dispatches every delivery still `queued`, in arrival
   order, from its stored prompt. The fire key keeps one that had already
   started from starting twice.

Every response carries `x-pathway-hook-outcome`. Metrics:
`pathway_webhook_deliveries_total`, `pathway_webhook_delivery_duration`,
`pathway_webhook_runs_total`.

## Storage

Migration 080 adds `webhook_token` and `webhook_secret` to `scheduled_tasks`,
outside `schedule_json` so neither reaches the read model, and
`scheduled_task_webhook_deliveries`. The upsert only sets a token when the row
has none, so a save racing `rotateWebhookToken` cannot restore the old URL; a
save without a secret keeps the stored one. Each task keeps its newest 50
deliveries with bodies and rendered prompts cut at 64 KiB (a queued delivery's
prompt is kept whole until it runs), and credential-named headers and query
values redacted. Deleting the task deletes its log. A save that keeps the
stored secret of a signed task fails if a concurrent save cleared it, rather
than leaving a signature check with no secret.

Linking, relinking or unlinking Pathway Connect calls
`ScheduledTaskService.refreshWebhookAddresses`, so open task lists pick up the
new public URL. A save from a `mobile` client cannot change a webhook task's
trigger: shipped iOS builds would otherwise save it back as a 09:00 daily task.

Token paths never reach traces or request logs: `untracedWebhookRequestsLayer`
disables the HTTP server span for `/api/hooks/*`, and the global
`unloggedWebhookRequestsLayer` disables the request logger for the same prefix,
including methods and paths no webhook route matches.

## Public URL

`task.webhook.url` is the managed tunnel's public origin plus the path, read
from the `cloud-managed-endpoint-url` secret while a managed tunnel runtime
config is stored. Linking stores it from `RelayEnvironmentConfigRequest.endpoint`
(sent by the web link flow and the CLI reconcile); an environment linked by a
client that predates the field has `url: null` until it is linked again.
Clients then resolve `webhook.path` against the address they reach the
environment at (`@spiritdevs/client-runtime/webhook-address`).

The managed tunnel forwards these requests unchanged: the relay provisions the
cloudflared ingress as `hostname -> http://<local host>:<port>` with a
`http_status:404` catch-all and no path rules or Access policy, and the local
server has no global auth middleware, so `/api/hooks/*` reaches the route with
its raw body, the same way the relay's own unauthenticated
`/api/pathway-connect/health` calls do. Zone-level Cloudflare settings (WAF,
bot protection) are outside this repo and could still challenge senders.

## Visibility

`rotateWebhookToken`, `listWebhookDeliveries` and `getWebhookDelivery` need
operate scope. `scheduledTasks.list` and `.subscribe` strip `webhook` from tasks
for sessions without operate scope. The task list decodes with
`ForwardCompatibleArray`, so a client drops a task it cannot decode instead of
the whole list. Clients built before this change decode the list strictly and
fail on any webhook task.
