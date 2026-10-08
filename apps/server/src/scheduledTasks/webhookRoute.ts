import { EnvironmentHttpApi } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpIncomingMessage from "effect/unstable/http/HttpIncomingMessage";
import * as HttpMiddleware from "effect/unstable/http/HttpMiddleware";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import * as Metrics from "../observability/Metrics.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

/** Largest request body a webhook accepts. */
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

/** Names what happened to the request, so a sender's delivery log is useful; never contents. */
const WEBHOOK_OUTCOME_HEADER = "x-pathway-hook-outcome";

const json = (status: number, body: Record<string, string>, outcome: string) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { [WEBHOOK_OUTCOME_HEADER]: outcome } });

const isWebhookRequest = (request: HttpServerRequest.HttpServerRequest) =>
  request.url.startsWith(`${ScheduledTaskService.WEBHOOK_ROUTE_PREFIX}/`);

/**
 * Webhook URLs carry their secret token in the path, so requests to them never
 * open an HTTP server span (which records the full URL).
 */
export const untracedWebhookRequestsLayer = Layer.succeed(HttpMiddleware.TracerDisabledWhen)(
  isWebhookRequest,
);

/**
 * Keeps webhook-shaped URLs out of the response log. Global so requests that
 * never match the webhook routes (other methods, malformed paths) are covered.
 */
export const unloggedWebhookRequestsLayer = HttpRouter.middleware(
  (httpApp) =>
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      return yield* isWebhookRequest(request)
        ? HttpMiddleware.withLoggerDisabled(httpApp)
        : httpApp;
    }),
  { global: true },
);

export const webhookHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "webhooks",
  Effect.fnUntraced(function* (handlers) {
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    /**
     * Handles `/api/hooks/:hookId/:token` for every accepted method. The
     * endpoint is raw so the signature is checked over the exact body bytes;
     * the service checks the token and signature. It is reachable directly or
     * over the environment's Pathway Connect managed tunnel.
     */
    const handler = ({
      params,
      request,
    }: {
      readonly params: { readonly hookId: string; readonly token: string };
      readonly request: HttpServerRequest.HttpServerRequest;
    }) =>
      Effect.gen(function* () {
        const contentLength = Number(request.headers["content-length"] ?? "0");
        // Refused before a task is looked up, so the service never sees them.
        const tooLarge = (error: string) =>
          Metrics.increment(Metrics.webhookDeliveriesTotal, { outcome: "body_too_large" }).pipe(
            Effect.as(json(413, { error }, "body_too_large")),
          );
        if (!Number.isFinite(contentLength) || contentLength > WEBHOOK_MAX_BODY_BYTES) {
          return yield* tooLarge("body_too_large");
        }
        // Chunked requests carry no content-length, so the reader itself is capped.
        const body = yield* request.arrayBuffer.pipe(
          Effect.map((buffer) => new Uint8Array(buffer)),
          Effect.provideService(
            HttpIncomingMessage.MaxBodySize,
            FileSystem.Size(WEBHOOK_MAX_BODY_BYTES),
          ),
          Effect.option,
        );
        if (Option.isNone(body)) return yield* tooLarge("body_too_large_or_unreadable");
        if (body.value.byteLength > WEBHOOK_MAX_BODY_BYTES) {
          return yield* tooLarge("body_too_large");
        }

        const headers: Record<string, string> = {};
        for (const [name, value] of Object.entries(request.headers)) {
          if (typeof value === "string") headers[name.toLowerCase()] = value;
        }
        const queryIndex = request.url.indexOf("?");

        const result = yield* scheduledTasks
          .triggerWebhook({
            hookId: params.hookId,
            token: params.token,
            method: request.method,
            path: `${ScheduledTaskService.WEBHOOK_ROUTE_PREFIX}/${encodeURIComponent(params.hookId)}`,
            query: queryIndex === -1 ? "" : request.url.slice(queryIndex + 1),
            headers,
            body: body.value,
            bodyText: new TextDecoder().decode(body.value),
          })
          .pipe(
            // Defects too, so the sender only ever sees the fixed error body.
            Effect.catchCause((cause) =>
              Effect.logWarning("Webhook delivery failed").pipe(
                Effect.annotateLogs({ hookId: params.hookId }),
                Effect.andThen(Effect.logDebug("Webhook delivery failure cause", { cause })),
                Effect.as({ _tag: "error" as const }),
              ),
            ),
          );

        switch (result._tag) {
          case "accepted":
            return json(202, { deliveryId: result.deliveryId }, result.outcome);
          case "not_found":
            return json(404, { error: "hook_not_found" }, "not_found");
          case "rejected_signature":
            return json(401, { error: "invalid_signature" }, "rejected_signature");
          case "disabled":
            return json(409, { error: "hook_disabled" }, "disabled");
          case "rate_limited":
            return json(429, { error: "rate_limited" }, result.outcome);
          case "error":
            return json(500, { error: "internal_error" }, "error");
        }
      });
    return handlers
      .handleRaw("webhookPost", handler)
      .handleRaw("webhookPut", handler)
      .handleRaw("webhookPatch", handler)
      .handleRaw("webhookGet", handler);
  }),
);
