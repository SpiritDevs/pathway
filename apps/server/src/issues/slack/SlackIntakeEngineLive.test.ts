import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { SlackApiClient, SlackApiError, type SlackApiClientShape } from "./SlackApiClient.ts";
import { SlackIntakeEngine } from "./SlackIntakeEngine.ts";
import * as SlackIntakeEngineLive from "./SlackIntakeEngineLive.ts";
import * as SlackIntakeSignal from "./SlackIntakeSignal.ts";
import { SLACK_BOT_TOKEN_SECRET } from "./slackToken.ts";

const encoder = new TextEncoder();

/** Every token the client was handed, so a test can prove which one each call used. */
const tokensSeen: Array<string> = [];

const makeClient = (overrides: Partial<SlackApiClientShape> = {}): SlackApiClientShape => ({
  authTest: ({ token }) =>
    Effect.sync(() => {
      tokensSeen.push(token);
      return {
        workspaceId: "T0PATHWAY",
        workspaceName: "Pathway HQ",
        workspaceDomain: "pathway",
        botUserId: "U0BOT",
        botId: "B0BOT",
      };
    }),
  listChannels: ({ token }) =>
    Effect.sync(() => {
      tokensSeen.push(token);
      return [{ id: "C1", name: "support" }];
    }),
  history: () => Effect.succeed({ messages: [], hasMore: false, nextCursor: null }),
  replies: () => Effect.succeed([]),
  postToThread: ({ token }) =>
    Effect.sync(() => {
      tokensSeen.push(token);
      return { messageTs: "9000.000001" };
    }),
  permalink: () => Effect.succeed(null),
  displayName: () => Effect.succeed(null),
  downloadImage: () => Effect.succeed(null),
  ...overrides,
});

const makeLayer = (client: SlackApiClientShape) =>
  SlackIntakeEngineLive.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(Layer.succeed(SlackApiClient, client), SlackIntakeSignal.layer),
    ),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "pathway-slack-engine-test-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );

const storeToken = (token: string) =>
  Effect.flatMap(ServerSecretStore.ServerSecretStore, (store) =>
    store.set(SLACK_BOT_TOKEN_SECRET, encoder.encode(token)),
  );

describe("SlackIntakeEngineLive", () => {
  it.effect("tries the candidate token itself, never the stored one", () =>
    Effect.gen(function* () {
      tokensSeen.length = 0;
      yield* storeToken("xoxb-stored");
      const engine = yield* SlackIntakeEngine;
      const result = yield* engine.testConnection({ token: "xoxb-candidate" });

      assert.strictEqual(result.workspaceName, "Pathway HQ");
      assert.deepStrictEqual(tokensSeen, ["xoxb-candidate"]);
    }).pipe(Effect.provide(makeLayer(makeClient()))),
  );

  it.effect("reports a rejected token as invalid, in Slack's own words", () =>
    Effect.gen(function* () {
      const engine = yield* SlackIntakeEngine;
      const failure = yield* Effect.flip(engine.testConnection({ token: "nope" }));

      assert.strictEqual(failure.reason, "invalid");
      assert.strictEqual(
        failure.message,
        "Slack rejected the bot token. Generate a new one and save it again.",
      );
    }).pipe(
      Effect.provide(
        makeLayer(
          makeClient({
            authTest: () =>
              Effect.fail(
                new SlackApiError({
                  operation: "auth.test",
                  code: "invalid_auth",
                  status: 200,
                  detail: null,
                }),
              ),
          }),
        ),
      ),
    ),
  );

  it.effect("refuses to list channels until a token has been stored, then lists them", () =>
    Effect.gen(function* () {
      const engine = yield* SlackIntakeEngine;
      const failure = yield* Effect.flip(engine.listChannels);
      assert.strictEqual(failure.message, "Slack is not connected. Save a bot token first.");

      yield* storeToken("xoxb-1");
      assert.deepStrictEqual(yield* engine.listChannels, [{ id: "C1", name: "support" }]);
    }).pipe(Effect.provide(makeLayer(makeClient()))),
  );

  it.effect("posts with the stored token and answers with the ts the registry needs", () =>
    Effect.gen(function* () {
      tokensSeen.length = 0;
      const engine = yield* SlackIntakeEngine;
      yield* storeToken("xoxb-stored");
      const posted = yield* engine.postIssueUpdate({
        channelId: "C1",
        threadTs: "100.000000",
        text: "Pathway user: on it",
      });

      assert.strictEqual(posted.messageTs, "9000.000001");
      assert.deepStrictEqual(tokensSeen, ["xoxb-stored"]);
    }).pipe(Effect.provide(makeLayer(makeClient()))),
  );

  // `it.live`, because the assertion is about a wait that never ends: under the test clock a
  // second take would hang rather than lose the race.
  it.live("pokes the poller when the watches change, and coalesces the pokes", () =>
    Effect.gen(function* () {
      const engine = yield* SlackIntakeEngine;
      const signal = yield* SlackIntakeSignal.SlackIntakeSignal;

      // Three writes while the loop sleeps are one pass to make afterwards, not three.
      yield* engine.notifyWatchesChanged;
      yield* engine.notifyWatchesChanged;
      yield* engine.notifyWatchesChanged;

      yield* signal.awaitNotification;
      const secondArrived = yield* Effect.raceFirst(
        Effect.as(signal.awaitNotification, true),
        Effect.as(Effect.sleep(Duration.millis(20)), false),
      );
      assert.strictEqual(secondArrived, false);
    }).pipe(Effect.provide(makeLayer(makeClient()))),
  );
});
