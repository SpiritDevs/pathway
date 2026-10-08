import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentHttpApi,
  ScheduledTaskError,
  ScheduledTaskWebhookDeliveryId,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";
import { HttpApi, HttpApiBuilder } from "effect/unstable/httpapi";

import {
  ScheduledTaskService,
  type WebhookTriggerRequest,
  type WebhookTriggerResult,
} from "./ScheduledTaskService.ts";
import { WEBHOOK_MAX_BODY_BYTES, webhookHttpApiLayer } from "./webhookRoute.ts";

class WebhookTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.webhooks) {}

const handlerFor = (
  trigger: (
    request: WebhookTriggerRequest,
  ) => Effect.Effect<WebhookTriggerResult, ScheduledTaskError>,
) =>
  HttpRouter.toWebHandler(
    HttpApiBuilder.layer(WebhookTestApi).pipe(
      Layer.provide(webhookHttpApiLayer),
      Layer.provide(Layer.mock(ScheduledTaskService)({ triggerWebhook: trigger })),
      Layer.provide(NodeHttpServer.layerHttpServices),
    ),
    { disableLogger: true },
  );

const post = (
  path: string,
  body: string | Uint8Array<ArrayBuffer>,
  headers: Record<string, string> = {},
) => new Request(`http://env.local${path}`, { method: "POST", body, headers });

describe("webhook route", () => {
  it("passes the raw request to the service and answers 202 with the delivery id", async () => {
    let received: WebhookTriggerRequest | undefined;
    const { handler, dispose } = handlerFor((request) => {
      received = request;
      return Effect.succeed({
        _tag: "accepted",
        deliveryId: ScheduledTaskWebhookDeliveryId.make("delivery:1"),
        outcome: "accepted",
      });
    });
    try {
      const response = await handler(
        post("/api/hooks/scheduled-task%3Ahook/tok?x=1", '{"a":1}', {
          "Content-Type": "application/json",
          "X-GitHub-Event": "push",
        }),
      );
      expect(response.status).toBe(202);
      expect(response.headers.get("x-pathway-hook-outcome")).toBe("accepted");
      expect(await response.json()).toEqual({ deliveryId: "delivery:1" });
      expect(received?.hookId).toBe("scheduled-task:hook");
      expect(received?.token).toBe("tok");
      expect(received?.query).toBe("x=1");
      expect(received?.headers["x-github-event"]).toBe("push");
      expect(received?.bodyText).toBe('{"a":1}');
      expect(new TextDecoder().decode(received?.body)).toBe('{"a":1}');
    } finally {
      await dispose();
    }
  });

  it("maps service outcomes to status codes and names each outcome", async () => {
    const deliveryId = ScheduledTaskWebhookDeliveryId.make("delivery:1");
    const cases: ReadonlyArray<[WebhookTriggerResult, number, string]> = [
      [{ _tag: "accepted", deliveryId, outcome: "accepted" }, 202, "accepted"],
      // Same status as a started run; only the header tells them apart.
      [{ _tag: "accepted", deliveryId, outcome: "prompt_too_long" }, 202, "prompt_too_long"],
      [{ _tag: "not_found" }, 404, "not_found"],
      [{ _tag: "rejected_signature" }, 401, "rejected_signature"],
      [{ _tag: "disabled" }, 409, "disabled"],
      [{ _tag: "rate_limited", outcome: "rate_limited" }, 429, "rate_limited"],
      [{ _tag: "rate_limited", outcome: "queue_full" }, 429, "queue_full"],
    ];
    for (const [result, status, outcome] of cases) {
      const { handler, dispose } = handlerFor(() => Effect.succeed(result));
      try {
        const response = await handler(post("/api/hooks/id/tok", "{}"));
        expect(response.status).toBe(status);
        expect(response.headers.get("x-pathway-hook-outcome")).toBe(outcome);
      } finally {
        await dispose();
      }
    }
  });

  it("accepts the other webhook methods", async () => {
    const methods: Array<string> = [];
    const { handler, dispose } = handlerFor((request) => {
      methods.push(request.method);
      return Effect.succeed({ _tag: "not_found" });
    });
    try {
      for (const method of ["PUT", "PATCH"]) {
        await handler(new Request("http://env.local/api/hooks/id/tok", { method, body: "{}" }));
      }
      await handler(new Request("http://env.local/api/hooks/id/tok?ping=1"));
      expect(methods).toEqual(["PUT", "PATCH", "GET"]);
    } finally {
      await dispose();
    }
  });

  it("rejects oversized bodies and malformed paths before reaching the service", async () => {
    let calls = 0;
    const { handler, dispose } = handlerFor(() => {
      calls += 1;
      return Effect.succeed({ _tag: "not_found" });
    });
    try {
      const big = new Uint8Array(WEBHOOK_MAX_BODY_BYTES + 1);
      const tooLarge = await handler(post("/api/hooks/id/tok", big));
      expect(tooLarge.status).toBe(413);
      expect(tooLarge.headers.get("x-pathway-hook-outcome")).toBe("body_too_large");
      expect((await handler(post("/api/hooks/id", "{}"))).status).toBe(404);
      expect((await handler(post("/api/hooks/id/tok/extra", "{}"))).status).toBe(404);
      // No content-length: the reader cap must still apply.
      const chunked = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let sent = 0; sent <= WEBHOOK_MAX_BODY_BYTES; sent += 64 * 1024) {
            controller.enqueue(new Uint8Array(64 * 1024));
          }
          controller.close();
        },
      });
      const streamed = await handler(
        new Request("http://env.local/api/hooks/id/tok", {
          method: "POST",
          body: chunked,
          // Node's fetch needs duplex for streamed bodies.
          duplex: "half",
        } as RequestInit),
      );
      expect(streamed.status).toBe(413);
      expect(calls).toBe(0);
    } finally {
      await dispose();
    }
  });

  it("hides service failures and defects behind a fixed 500", async () => {
    const failures = [
      Effect.fail(new ScheduledTaskError({ message: "database locked" })),
      Effect.die(new Error("database exploded")),
    ];
    for (const failure of failures) {
      const { handler, dispose } = handlerFor(() => failure);
      try {
        const response = await handler(post("/api/hooks/id/tok", "{}"));
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: "internal_error" });
      } finally {
        await dispose();
      }
    }
  });
});
