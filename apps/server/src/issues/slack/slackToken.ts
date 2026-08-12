/**
 * Where the Slack bot token lives, and how anything that needs it reads it.
 *
 * Two halves of intake need the token and neither owns it: `IssueTrackerService` writes it when
 * settings accepts one, and the poller reads it at the top of every cycle. Naming the file in one
 * place is what keeps those from drifting apart — a reader looking at
 * `<secretsDir>/slack-bot-tokens.bin` would report "not connected" forever and never say why.
 *
 * Reading per cycle rather than at startup is deliberate: a token saved in settings has to start
 * working on the next pass, not on the next restart of a server that may not restart for weeks.
 *
 * @module issues/slack/slackToken
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ServerSecretStore } from "../../auth/ServerSecretStore.ts";

/** `<secretsDir>/slack-bot-token.bin`, 0600, written through a temp file and a rename. */
export const SLACK_BOT_TOKEN_SECRET = "slack-bot-token";

const decoder = new TextDecoder();

/**
 * The stored token, or `None` when Slack is not connected.
 *
 * Takes the store as a value rather than reading its tag, because both callers hold it already
 * and neither's published shape has room for a requirement: the engine's methods are
 * `Effect<A, IssueTrackerError>` and the poller's cycle is `Effect<void>`.
 *
 * A read failure is `None` too, and logged rather than raised: the caller's answer to both is the
 * same — do not poll — and a poll loop that died because the secrets directory was briefly busy
 * would stay dead until the server restarted.
 */
export const readSlackBotToken = (
  store: ServerSecretStore["Service"],
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    const stored = yield* store
      .get(SLACK_BOT_TOKEN_SECRET)
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to read the Slack bot token.", { cause }).pipe(
            Effect.as(Option.none<Uint8Array>()),
          ),
        ),
      );
    if (Option.isNone(stored)) return Option.none();
    const token = decoder.decode(stored.value).trim();
    return token.length === 0 ? Option.none() : Option.some(token);
  });
