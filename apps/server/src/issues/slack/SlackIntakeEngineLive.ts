/**
 * The live {@link SlackIntakeEngine}: the tracker's four synchronous errands against Slack.
 *
 * Small on purpose. Everything periodic lives in `SlackIntakePoller.ts`, which is a separate
 * layer for a structural reason rather than a tidiness one: the tracker requires this engine, so
 * an engine that required the tracker back would be a cycle neither layer could build out of.
 * The poller is allowed to require both because nothing requires the poller.
 *
 * What is left here is the three calls a settings page makes — try this token, list the channels,
 * post this update — plus the poke that shortens the wait after a watch changes.
 *
 * @module issues/slack/SlackIntakeEngineLive
 */
import { IssueTrackerError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";
import { SlackApiClient, type SlackApiError } from "./SlackApiClient.ts";
import { SlackIntakeEngine, type SlackIntakeEngineShape } from "./SlackIntakeEngine.ts";
import { SlackIntakeSignal } from "./SlackIntakeSignal.ts";
import { readSlackBotToken } from "./slackToken.ts";

/**
 * Slack's failures reach the client as tracker errors, because the client's only vocabulary is
 * `IssueTrackerError`. The sentence survives; `SlackApiError` already writes a human one.
 */
const asTrackerError = (error: SlackApiError): IssueTrackerError =>
  new IssueTrackerError({
    reason: error.code === "invalid_auth" || error.code === "not_authed" ? "invalid" : "storage",
    message: error.message,
  });

const notConnected = new IssueTrackerError({
  reason: "invalid",
  message: "Slack is not connected. Save a bot token first.",
});

export const make = Effect.gen(function* () {
  const client = yield* SlackApiClient;
  const signal = yield* SlackIntakeSignal;
  const secretStore = yield* ServerSecretStore;

  /** Everything but `testConnection` needs the stored token; there is nothing to do without it. */
  const withToken = <A>(
    use: (token: string) => Effect.Effect<A, SlackApiError>,
  ): Effect.Effect<A, IssueTrackerError> =>
    readSlackBotToken(secretStore).pipe(
      Effect.flatMap((token) =>
        Option.isNone(token)
          ? Effect.fail(notConnected)
          : use(token.value).pipe(Effect.mapError(asTrackerError)),
      ),
    );

  const testConnection: SlackIntakeEngineShape["testConnection"] = (input) =>
    client.authTest({ token: input.token }).pipe(
      Effect.mapError(asTrackerError),
      Effect.map((identity) => ({ workspaceName: identity.workspaceName })),
    );

  const listChannels: SlackIntakeEngineShape["listChannels"] = withToken((token) =>
    client.listChannels({ token }),
  );

  const postIssueUpdate: SlackIntakeEngineShape["postIssueUpdate"] = (input) =>
    withToken((token) =>
      client.postToThread({
        token,
        channelId: input.channelId,
        threadTs: input.threadTs,
        text: input.text,
      }),
    );

  return {
    testConnection,
    listChannels,
    notifyWatchesChanged: signal.notify,
    postIssueUpdate,
  } satisfies SlackIntakeEngineShape;
});

export const layer = Layer.effect(SlackIntakeEngine, make);
