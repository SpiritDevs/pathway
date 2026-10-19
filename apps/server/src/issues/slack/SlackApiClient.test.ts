import { describe, expect, it, vi } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientRequest, HttpClientResponse, UrlParams } from "effect/unstable/http";

import { SlackApiClient, layerWith } from "./SlackApiClient.ts";

const BASE_URL = "https://slack.test/api";

/**
 * Slack, faked at the socket. Nothing in this file reaches the network: the client is built over
 * an `HttpClient` that answers from a function, which is the same shape `BitbucketApi.test.ts`
 * uses.
 *
 * The spacing is zero here on purpose. One second between calls is the right policy against a
 * real workspace and the wrong one in a test suite, and the gap is the one behaviour these tests
 * do not assert.
 */
function makeLayer(respond: (request: HttpClientRequest.HttpClientRequest) => Response) {
  const execute = vi.fn((request: HttpClientRequest.HttpClientRequest) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, respond(request))),
  );
  const layer = layerWith({ baseUrl: BASE_URL, callSpacingMs: 0 }).pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => execute(request)),
      ),
    ),
  );
  return { execute, layer };
}

const path = (request: HttpClientRequest.HttpClientRequest) => new URL(request.url).pathname;

/** Query parameters live beside the url on an `HttpClientRequest`, not inside it. */
const param = (request: HttpClientRequest.HttpClientRequest, name: string): string | null =>
  Option.getOrNull(UrlParams.getFirst(request.urlParams, name));

describe("SlackApiClient", () => {
  it.effect("reads the workspace and the bot's own ids off auth.test", () => {
    const { execute, layer } = makeLayer(() =>
      Response.json({
        ok: true,
        team: "Pathway HQ",
        team_id: "T0PATHWAY",
        url: "https://pathway.slack.com/",
        user_id: "U0BOT",
        bot_id: "B0BOT",
      }),
    );
    return Effect.gen(function* () {
      const client = yield* SlackApiClient;
      const identity = yield* client.authTest({ token: "xoxb-1" });

      expect(identity).toEqual({
        workspaceId: "T0PATHWAY",
        workspaceName: "Pathway HQ",
        workspaceDomain: "pathway",
        botUserId: "U0BOT",
        botId: "B0BOT",
      });
      const request = execute.mock.calls[0]![0];
      expect(request.headers["authorization"]).toBe("Bearer xoxb-1");
      expect(path(request)).toBe("/api/auth.test");
    }).pipe(Effect.provide(layer));
  });

  it.effect("turns Slack's own refusal into a sentence, even though HTTP said 200", () => {
    const { layer } = makeLayer(() => Response.json({ ok: false, error: "invalid_auth" }));
    return Effect.gen(function* () {
      const client = yield* SlackApiClient;
      const failure = yield* Effect.flip(client.authTest({ token: "xoxb-bad" }));

      expect(failure.code).toBe("invalid_auth");
      expect(failure.message).toBe(
        "Slack rejected the bot token. Generate a new one and save it again.",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("names the scope a missing_scope refusal asked for", () => {
    const { layer } = makeLayer(() =>
      Response.json({ ok: false, error: "missing_scope", needed: "channels:history" }),
    );
    return Effect.gen(function* () {
      const client = yield* SlackApiClient;
      const failure = yield* Effect.flip(client.history({ token: "t", channelId: "C1" }));

      expect(failure.message).toBe("The Slack bot token is missing the channels:history scope.");
    }).pipe(Effect.provide(layer));
  });

  it.effect("follows conversations.list cursors and drops archived channels", () => {
    const pages = [
      Response.json({
        ok: true,
        channels: [
          { id: "C1", name: "support" },
          { id: "C2", name: "old", is_archived: true },
        ],
        response_metadata: { next_cursor: "page-2" },
      }),
      Response.json({ ok: true, channels: [{ id: "C3", name: "design" }] }),
    ];
    let call = 0;
    const { execute, layer } = makeLayer(() => pages[call++] ?? Response.json({ ok: true }));

    return Effect.gen(function* () {
      const client = yield* SlackApiClient;
      const channels = yield* client.listChannels({ token: "t" });

      expect(channels).toEqual([
        { id: "C1", name: "support" },
        { id: "C3", name: "design" },
      ]);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(param(execute.mock.calls[1]![0], "cursor")).toBe("page-2");
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks conversations.history exclusively from the stored cursor", () => {
    const { execute, layer } = makeLayer(() =>
      Response.json({
        ok: true,
        messages: [{ ts: "2.000000", text: "hi" }],
        has_more: true,
        response_metadata: { next_cursor: "page-2" },
      }),
    );
    return Effect.gen(function* () {
      const client = yield* SlackApiClient;
      const page = yield* client.history({
        token: "t",
        channelId: "C1",
        oldest: "1.000000",
        limit: 100,
      });

      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toBe("page-2");
      expect(page.messages).toHaveLength(1);
      const request = execute.mock.calls[0]![0];
      expect(param(request, "channel")).toBe("C1");
      expect(param(request, "oldest")).toBe("1.000000");
      expect(param(request, "inclusive")).toBe("false");
      expect(param(request, "limit")).toBe("100");
    }).pipe(Effect.provide(layer));
  });

  it.effect("sits out a 429 for as long as Slack asked, then succeeds", () => {
    let call = 0;
    const { execute, layer } = makeLayer(() => {
      call += 1;
      return call === 1
        ? new Response("", { status: 429, headers: { "retry-after": "1" } })
        : Response.json({ ok: true, ts: "9.000001" });
    });

    return Effect.gen(function* () {
      const client = yield* SlackApiClient;
      const fiber = yield* Effect.forkScoped(
        client.postToThread({ token: "t", channelId: "C1", threadTs: "1.0", text: "hi" }),
      );

      yield* Effect.yieldNow;
      expect(execute).toHaveBeenCalledTimes(1);

      yield* TestClock.adjust(Duration.seconds(1));
      const posted = yield* Fiber.join(fiber);

      expect(posted.messageTs).toBe("9.000001");
      expect(execute).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(Layer.mergeAll(layer, TestClock.layer())), Effect.scoped);
  });

  it.effect("refuses a post Slack answered without a ts, which nothing could recognise", () => {
    const { layer } = makeLayer(() => Response.json({ ok: true }));
    return Effect.gen(function* () {
      const client = yield* SlackApiClient;
      const failure = yield* Effect.flip(
        client.postToThread({ token: "t", channelId: "C1", threadTs: "1.0", text: "hi" }),
      );

      expect(failure.detail).toBe("no message ts in response");
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "asks Slack for a display name once per user, and drops the cache with the token",
    () => {
      const { execute, layer } = makeLayer((request) =>
        Response.json({
          ok: true,
          user: {
            id: param(request, "user"),
            name: "ann",
            profile: { display_name: param(request, "user") === "U1" ? "Ann Rivers" : "" },
          },
        }),
      );

      return Effect.gen(function* () {
        const client = yield* SlackApiClient;
        expect(yield* client.displayName({ token: "t1", userId: "U1" })).toBe("Ann Rivers");
        expect(yield* client.displayName({ token: "t1", userId: "U1" })).toBe("Ann Rivers");
        expect(execute).toHaveBeenCalledTimes(1);

        // A new token can be a different workspace, where U1 is somebody else entirely.
        expect(yield* client.displayName({ token: "t2", userId: "U1" })).toBe("Ann Rivers");
        expect(execute).toHaveBeenCalledTimes(2);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("downloads an image with the bot token and refuses anything that is not one", () => {
    const png = new Uint8Array([1, 2, 3, 4]);
    const { execute, layer } = makeLayer((request) =>
      path(request).endsWith("shot.png")
        ? new Response(png, { status: 200, headers: { "content-type": "image/png" } })
        : new Response("<html>sign in</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
    );

    return Effect.gen(function* () {
      const client = yield* SlackApiClient;
      const image = yield* client.downloadImage({
        token: "t",
        url: "https://files.slack.test/shot.png",
      });
      expect(image?.mimeType).toBe("image/png");
      expect(image?.bytes).toEqual(png);
      expect(execute.mock.calls[0]?.[0].headers["authorization"]).toBe("Bearer t");

      const signIn = yield* client.downloadImage({
        token: "t",
        url: "https://files.slack.test/private",
      });
      expect(signIn).toBeNull();
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses an image past the ceiling rather than filing a huge one", () => {
    const { layer } = makeLayer(
      () =>
        new Response(new Uint8Array(64), { status: 200, headers: { "content-type": "image/png" } }),
    );
    return Effect.gen(function* () {
      const client = yield* SlackApiClient;
      const image = yield* client.downloadImage({
        token: "t",
        url: "https://files.slack.test/big.png",
        maxBytes: 8,
      });
      expect(image).toBeNull();
    }).pipe(Effect.provide(layer));
  });
});
