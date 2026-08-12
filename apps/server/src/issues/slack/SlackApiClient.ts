/**
 * SlackApiClient - the only thing in this repository that talks to Slack.
 *
 * Plain HTTPS and JSON through the `HttpClient` every other integration here uses
 * (`sourceControl/BitbucketApi.ts` is the nearest neighbour); there is no Slack SDK dependency,
 * because the eight endpoints intake needs are eight URLs.
 *
 * Three shapes worth knowing before reading:
 *
 * - **The token is an argument, never state.** Every call takes the token the caller just read
 *   from `secretsDir`, so a token replaced in settings takes effect on the next poll rather than
 *   on the next restart. The one thing the client does remember is display names, and that cache
 *   is dropped the moment the token changes — a new token can mean a different workspace, where
 *   `U0123` is somebody else entirely.
 *
 * - **One call at a time, spaced.** Slack's limits are per method per workspace, and a poll of
 *   twenty channels is twenty `conversations.history` calls in a burst. A permit plus a minimum
 *   gap is enough to stay under Tier 3 without modelling Slack's buckets, and it makes the whole
 *   integration's load predictable: one call every {@link DEFAULT_CALL_SPACING_MS} milliseconds,
 *   whatever the poller asks for.
 *
 * - **429 is honoured, not retried blindly.** Slack says how long to wait in `Retry-After`; the
 *   call sleeps that long, still holding the permit, so the rest of the cycle queues behind it
 *   rather than piling more requests onto a workspace that just asked for quiet.
 *
 * @module issues/slack/SlackApiClient
 */
import type { SlackChannelRef } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { Headers, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

/** Slack's own base. Overridable per layer so a test can point at nothing at all. */
export const SLACK_API_BASE_URL = "https://slack.com/api";

/**
 * The gap held between calls. Slack's Tier 3 is roughly 50 per minute per method, and Tier 2 is
 * 20; one call per second across every method is comfortably under both without needing to know
 * which tier an endpoint is in.
 */
export const DEFAULT_CALL_SPACING_MS = 1_000;

/** How many times a single call will sit out a `Retry-After` before giving up on the cycle. */
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 3;

/** A `Retry-After` past this is not worth waiting for inside a poll; the next cycle can try. */
const MAX_RETRY_AFTER_SECONDS = 60;

/** History pages. Slack's ceiling is 1000; 200 is a page that fits a sleepy laptop's catch-up. */
export const SLACK_HISTORY_PAGE_SIZE = 200;

/** An image past this is left in Slack. The tracker refuses it anyway (10 MB). */
export const SLACK_MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Every Slack failure, as one error with a sentence a settings page can show.
 *
 * `code` is Slack's own machine word (`invalid_auth`, `not_in_channel`) when it gave one, which
 * is what the poller keys its per-channel handling off; `message` is the sentence for a human,
 * because "not_in_channel" tells nobody what to do about it.
 */
export class SlackApiError extends Schema.TaggedErrorClass<SlackApiError>()("SlackApiError", {
  operation: Schema.String,
  code: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.Int),
  detail: Schema.NullOr(Schema.String),
}) {
  override get message(): string {
    return describeSlackFailure(this);
  }
}

/**
 * Slack's error words, as sentences that say what to do.
 *
 * Only the ones a user can act on are spelled out. Everything else keeps Slack's word, which is
 * at least searchable, rather than being flattened into "something went wrong".
 */
export function describeSlackFailure(input: {
  readonly operation: string;
  readonly code: string | null;
  readonly status: number | null;
  readonly detail: string | null;
}): string {
  switch (input.code) {
    case "invalid_auth":
    case "not_authed":
    case "token_revoked":
    case "token_expired":
      return "Slack rejected the bot token. Generate a new one and save it again.";
    case "account_inactive":
      return "The Slack app this token belongs to has been deactivated.";
    case "missing_scope":
    case "not_allowed_token_type":
      return input.detail === null
        ? "The Slack bot token is missing a scope this needs."
        : `The Slack bot token is missing the ${input.detail} scope.`;
    case "channel_not_found":
      return "That Slack channel no longer exists, or the bot cannot see it.";
    case "not_in_channel":
      return "The bot is not in that channel. Invite it there and it will start reading.";
    case "is_archived":
      return "That Slack channel is archived.";
    case "ratelimited":
    case "rate_limited":
      return "Slack is rate limiting this workspace. The next poll will try again.";
    case "msg_too_long":
      return "Slack refused the message for being too long.";
    case null:
      return input.status === null
        ? `Could not reach Slack (${input.operation}).`
        : `Slack answered ${input.operation} with HTTP ${input.status}.`;
    default:
      return `Slack refused ${input.operation}: ${input.code}.`;
  }
}

// ── Response schemas ─────────────────────────────────────────────────
//
// Minimal on purpose: Slack's payloads are enormous and every field named here is one intake
// actually reads. Unknown keys are ignored, so a Slack release that adds fields changes nothing.

const AuthTestResponse = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
  needed: Schema.optional(Schema.String),
  team: Schema.optional(Schema.String),
  team_id: Schema.optional(Schema.String),
  user_id: Schema.optional(Schema.String),
  bot_id: Schema.optional(Schema.String),
});

const ConversationsListResponse = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
  needed: Schema.optional(Schema.String),
  channels: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        name: Schema.optional(Schema.String),
        is_archived: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
  response_metadata: Schema.optional(
    Schema.Struct({ next_cursor: Schema.optional(Schema.String) }),
  ),
});

const SlackReactionSchema = Schema.Struct({
  name: Schema.String,
  count: Schema.optional(Schema.Number),
  users: Schema.optional(Schema.Array(Schema.String)),
});

const SlackFileSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  mimetype: Schema.optional(Schema.String),
  size: Schema.optional(Schema.Number),
  url_private: Schema.optional(Schema.String),
  url_private_download: Schema.optional(Schema.String),
});
export type SlackFile = typeof SlackFileSchema.Type;

const SlackMessageSchema = Schema.Struct({
  type: Schema.optional(Schema.String),
  subtype: Schema.optional(Schema.String),
  ts: Schema.String,
  thread_ts: Schema.optional(Schema.String),
  user: Schema.optional(Schema.String),
  username: Schema.optional(Schema.String),
  bot_id: Schema.optional(Schema.String),
  app_id: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  /** Present on a parent that has a thread. Zero and absent both mean nobody replied. */
  reply_count: Schema.optional(Schema.Number),
  reactions: Schema.optional(Schema.Array(SlackReactionSchema)),
  files: Schema.optional(Schema.Array(SlackFileSchema)),
});
export type SlackMessage = typeof SlackMessageSchema.Type;

const ConversationsHistoryResponse = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
  needed: Schema.optional(Schema.String),
  messages: Schema.optional(Schema.Array(SlackMessageSchema)),
  has_more: Schema.optional(Schema.Boolean),
  response_metadata: Schema.optional(
    Schema.Struct({ next_cursor: Schema.optional(Schema.String) }),
  ),
});

const ChatPostMessageResponse = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
  needed: Schema.optional(Schema.String),
  ts: Schema.optional(Schema.String),
});

const PermalinkResponse = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
  needed: Schema.optional(Schema.String),
  permalink: Schema.optional(Schema.String),
});

const UsersInfoResponse = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optional(Schema.String),
  needed: Schema.optional(Schema.String),
  user: Schema.optional(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      name: Schema.optional(Schema.String),
      real_name: Schema.optional(Schema.String),
      profile: Schema.optional(
        Schema.Struct({
          display_name: Schema.optional(Schema.String),
          real_name: Schema.optional(Schema.String),
        }),
      ),
    }),
  ),
});

// ── Service ──────────────────────────────────────────────────────────

/** Who the token is, read once per token and then remembered for the mention trigger. */
export interface SlackIdentity {
  readonly workspaceName: string;
  /** `U…`. A bot-mention trigger is a search for `<@thisId>` in a message. */
  readonly botUserId: string | null;
  /** `B…`. Every message carrying it is one this app posted, which is belt to the ledger's braces. */
  readonly botId: string | null;
}

export interface SlackHistoryPage {
  /** As Slack sends them: newest first. The poller reorders; nothing here does. */
  readonly messages: ReadonlyArray<SlackMessage>;
  /** The requested range holds more than this page does. */
  readonly hasMore: boolean;
  /** What to pass back as `cursor` for the rest of the range, or null at the end of it. */
  readonly nextCursor: string | null;
}

export interface SlackDownloadedImage {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

export interface SlackApiClientShape {
  /** `auth.test`. The token probe, and where the bot's own ids come from. */
  readonly authTest: (input: {
    readonly token: string;
  }) => Effect.Effect<SlackIdentity, SlackApiError>;

  /**
   * `conversations.list`, every page. Public and private channels the bot is in — a channel it is
   * not in cannot be read anyway, so offering it in the picker would only produce a broken watch.
   */
  readonly listChannels: (input: {
    readonly token: string;
  }) => Effect.Effect<ReadonlyArray<SlackChannelRef>, SlackApiError>;

  /**
   * `conversations.history`. `oldest` is exclusive here — the poller stores the last ts it read,
   * and asking inclusively would hand it that same message back on every cycle.
   *
   * One page. `nextCursor` is how a server that has been asleep for a week catches up: the whole
   * point of a cursor over a socket is that the backlog is still there when it wakes.
   */
  readonly history: (input: {
    readonly token: string;
    readonly channelId: string;
    readonly oldest?: string | null | undefined;
    readonly limit?: number | undefined;
    readonly cursor?: string | null | undefined;
  }) => Effect.Effect<SlackHistoryPage, SlackApiError>;

  /**
   * `conversations.replies`. Not part of the ordinary cycle: `conversations.history` already
   * carries replies in a channel the bot reads. This is the catch-up for a thread whose parent
   * was filed before the reply arrived out of the window.
   */
  readonly replies: (input: {
    readonly token: string;
    readonly channelId: string;
    readonly threadTs: string;
    readonly oldest?: string | null | undefined;
  }) => Effect.Effect<ReadonlyArray<SlackMessage>, SlackApiError>;

  /** `chat.postMessage`, always into a thread, answering with the ts the echo registry needs. */
  readonly postToThread: (input: {
    readonly token: string;
    readonly channelId: string;
    readonly threadTs: string;
    readonly text: string;
  }) => Effect.Effect<{ readonly messageTs: string }, SlackApiError>;

  /** `chat.getPermalink`. A nicety: null rather than a failure when Slack will not give one. */
  readonly permalink: (input: {
    readonly token: string;
    readonly channelId: string;
    readonly messageTs: string;
  }) => Effect.Effect<string | null, SlackApiError>;

  /**
   * `users.info`, cached in memory for the life of the token. A busy channel is a handful of
   * people, and asking Slack who they are on every message would spend the rate limit on names.
   */
  readonly displayName: (input: {
    readonly token: string;
    readonly userId: string;
  }) => Effect.Effect<string | null, SlackApiError>;

  /**
   * A file from `files.slack.com`, which needs the bot token as a bearer even though it is not
   * an API endpoint. Answers null for anything that is not an image or is over the ceiling: an
   * intake that refused a whole message because somebody attached a video would be worse than
   * one that filed the text and left the video in Slack.
   */
  readonly downloadImage: (input: {
    readonly token: string;
    readonly url: string;
    readonly declaredMimeType?: string | undefined;
    readonly maxBytes?: number | undefined;
  }) => Effect.Effect<SlackDownloadedImage | null, SlackApiError>;
}

export class SlackApiClient extends Context.Service<SlackApiClient, SlackApiClientShape>()(
  "t3/issues/slack/SlackApiClient",
) {}

export interface SlackApiClientOptions {
  readonly baseUrl?: string | undefined;
  /** Minimum gap between calls. Zero in tests, {@link DEFAULT_CALL_SPACING_MS} in the server. */
  readonly callSpacingMs?: number | undefined;
  readonly maxRateLimitRetries?: number | undefined;
}

/** Slack answers `ok: false` with an error word; that is a failure even though HTTP said 200. */
interface SlackEnvelope {
  readonly ok: boolean;
  readonly error: string | null;
  readonly needed: string | null;
}

const trimToNull = (value: string | undefined): string | null => {
  const trimmed = value?.trim() ?? "";
  return trimmed.length === 0 ? null : trimmed;
};

/**
 * The three fields every Slack response carries, read off a decoded body of any shape.
 *
 * Read structurally rather than through a generic bound: every schema in this module declares
 * them, and a bound that said so would have to be threaded through `schemaBodyJson`'s own
 * constraint for no gain.
 */
function readEnvelope(value: unknown): SlackEnvelope {
  const body = value as { readonly ok?: unknown; error?: unknown; needed?: unknown };
  return {
    ok: body.ok === true,
    error: typeof body.error === "string" ? trimToNull(body.error) : null,
    needed: typeof body.needed === "string" ? trimToNull(body.needed) : null,
  };
}

/** Slack sends seconds; anything unreadable is treated as one second rather than as forever. */
function parseRetryAfterSeconds(response: HttpClientResponse.HttpClientResponse): number {
  const header = Headers.get(response.headers, "retry-after");
  if (Option.isNone(header)) return 1;
  const seconds = Number.parseInt(header.value.trim(), 10);
  if (!Number.isFinite(seconds) || seconds <= 0) return 1;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

export const make = (
  options: SlackApiClientOptions = {},
): Effect.Effect<SlackApiClientShape, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const baseUrl = (options.baseUrl ?? SLACK_API_BASE_URL).replace(/\/+$/u, "");
    const callSpacingMs = Math.max(0, options.callSpacingMs ?? DEFAULT_CALL_SPACING_MS);
    const maxRateLimitRetries = Math.max(
      0,
      options.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES,
    );

    // The whole rate-limit policy: one call at a time, and never two inside the gap.
    const callSlot = yield* Semaphore.make(1);
    const lastCallAt = yield* Ref.make(0);

    /**
     * Display names, and the token they were read under.
     *
     * Keyed by the token rather than merely cleared on change, so a token swapped to a different
     * workspace cannot serve that workspace's `U0123` under this one's name.
     */
    const nameCache = yield* Ref.make<{
      readonly token: string;
      readonly names: ReadonlyMap<string, string | null>;
    }>({ token: "", names: new Map() });

    const spaced = <A>(effect: Effect.Effect<A, SlackApiError>): Effect.Effect<A, SlackApiError> =>
      callSlot.withPermits(1)(
        Effect.gen(function* () {
          if (callSpacingMs === 0) return yield* effect;
          const now = yield* Clock.currentTimeMillis;
          const earliest = (yield* Ref.get(lastCallAt)) + callSpacingMs;
          if (now < earliest) yield* Effect.sleep(Duration.millis(earliest - now));
          // The stamp goes on when the call *finishes*, failure included: a call that failed
          // still cost Slack a request, and the gap is about their counter, not ours.
          return yield* Effect.ensuring(
            effect,
            Effect.flatMap(Clock.currentTimeMillis, (finished) => Ref.set(lastCallAt, finished)),
          );
        }),
      );

    const failure = (
      operation: string,
      input: {
        readonly code?: string | null | undefined;
        readonly status?: number | null | undefined;
        readonly detail?: string | null | undefined;
      },
    ) =>
      new SlackApiError({
        operation,
        code: input.code ?? null,
        status: input.status ?? null,
        detail: input.detail ?? null,
      });

    /**
     * One HTTP round trip, with the 429 wait inside the permit.
     *
     * Retrying inside the permit is the point: a workspace that just said "wait" must not be
     * handed the rest of the poll cycle while this call sleeps.
     */
    const execute = (
      operation: string,
      request: HttpClientRequest.HttpClientRequest,
    ): Effect.Effect<HttpClientResponse.HttpClientResponse, SlackApiError> => {
      const attempt = (
        remaining: number,
      ): Effect.Effect<HttpClientResponse.HttpClientResponse, SlackApiError> =>
        httpClient.execute(request).pipe(
          Effect.mapError((cause) =>
            failure(operation, { status: null, detail: String(cause.reason ?? cause._tag) }),
          ),
          Effect.flatMap((response) => {
            if (response.status !== 429) return Effect.succeed(response);
            if (remaining <= 0) {
              return Effect.fail(failure(operation, { code: "ratelimited", status: 429 }));
            }
            return Effect.sleep(Duration.seconds(parseRetryAfterSeconds(response))).pipe(
              Effect.andThen(attempt(remaining - 1)),
            );
          }),
        );
      return spaced(attempt(maxRateLimitRetries));
    };

    const decode = <S extends Schema.Top>(
      operation: string,
      schema: S,
      response: HttpClientResponse.HttpClientResponse,
    ): Effect.Effect<S["Type"], SlackApiError, S["DecodingServices"]> =>
      HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.mapError(() =>
          failure(operation, { status: response.status, detail: "unreadable response" }),
        ),
        Effect.flatMap((body) => {
          const envelope = readEnvelope(body);
          if (response.status >= 400) {
            return Effect.fail(
              failure(operation, { code: envelope.error, status: response.status }),
            );
          }
          // Slack's own refusal, always HTTP 200. This is the failure that actually happens.
          return envelope.ok
            ? Effect.succeed(body)
            : Effect.fail(
                failure(operation, {
                  code: envelope.error ?? "unknown",
                  status: response.status,
                  detail: envelope.needed,
                }),
              );
        }),
      );

    const get = <S extends Schema.Top>(
      operation: string,
      token: string,
      params: Record<string, string>,
      schema: S,
    ): Effect.Effect<S["Type"], SlackApiError, S["DecodingServices"]> =>
      execute(
        operation,
        HttpClientRequest.get(`${baseUrl}/${operation}`).pipe(
          HttpClientRequest.setUrlParams(params),
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.acceptJson,
        ),
      ).pipe(Effect.flatMap((response) => decode(operation, schema, response)));

    const post = <S extends Schema.Top>(
      operation: string,
      token: string,
      body: Record<string, string>,
      schema: S,
    ): Effect.Effect<S["Type"], SlackApiError, S["DecodingServices"]> =>
      execute(
        operation,
        HttpClientRequest.post(`${baseUrl}/${operation}`).pipe(
          HttpClientRequest.bearerToken(token),
          HttpClientRequest.acceptJson,
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
      ).pipe(Effect.flatMap((response) => decode(operation, schema, response)));

    const authTest: SlackApiClientShape["authTest"] = (input) =>
      get("auth.test", input.token, {}, AuthTestResponse).pipe(
        Effect.map((body) => ({
          workspaceName: trimToNull(body.team) ?? trimToNull(body.team_id) ?? "Slack",
          botUserId: trimToNull(body.user_id),
          botId: trimToNull(body.bot_id),
        })),
      );

    const listChannels: SlackApiClientShape["listChannels"] = (input) =>
      Effect.gen(function* () {
        const collected: Array<SlackChannelRef> = [];
        let cursor = "";
        // Ten pages of 200 is two thousand channels; a workspace past that is not a picker.
        for (let page = 0; page < 10; page += 1) {
          const body = yield* get(
            "conversations.list",
            input.token,
            {
              types: "public_channel,private_channel",
              exclude_archived: "true",
              limit: "200",
              ...(cursor.length === 0 ? {} : { cursor }),
            },
            ConversationsListResponse,
          );
          for (const channel of body.channels ?? []) {
            if (channel.is_archived === true) continue;
            const name = trimToNull(channel.name);
            const id = trimToNull(channel.id);
            if (id === null || name === null) continue;
            collected.push({ id, name });
          }
          cursor = trimToNull(body.response_metadata?.next_cursor) ?? "";
          if (cursor.length === 0) break;
        }
        return collected;
      });

    const history: SlackApiClientShape["history"] = (input) =>
      get(
        "conversations.history",
        input.token,
        {
          channel: input.channelId,
          limit: String(input.limit ?? SLACK_HISTORY_PAGE_SIZE),
          inclusive: "false",
          ...(input.oldest === undefined || input.oldest === null ? {} : { oldest: input.oldest }),
          ...(input.cursor === undefined || input.cursor === null || input.cursor.length === 0
            ? {}
            : { cursor: input.cursor }),
        },
        ConversationsHistoryResponse,
      ).pipe(
        Effect.map((body) => ({
          messages: body.messages ?? [],
          hasMore: body.has_more === true,
          nextCursor: trimToNull(body.response_metadata?.next_cursor),
        })),
      );

    const replies: SlackApiClientShape["replies"] = (input) =>
      get(
        "conversations.replies",
        input.token,
        {
          channel: input.channelId,
          ts: input.threadTs,
          limit: String(SLACK_HISTORY_PAGE_SIZE),
          ...(input.oldest === undefined || input.oldest === null ? {} : { oldest: input.oldest }),
        },
        ConversationsHistoryResponse,
      ).pipe(Effect.map((body) => body.messages ?? []));

    const postToThread: SlackApiClientShape["postToThread"] = (input) =>
      post(
        "chat.postMessage",
        input.token,
        {
          channel: input.channelId,
          thread_ts: input.threadTs,
          text: input.text,
        },
        ChatPostMessageResponse,
      ).pipe(
        Effect.flatMap((body) => {
          const ts = trimToNull(body.ts);
          // A post with no ts is worse than a failed one: nothing would recognise it as the
          // bot's own, and the next poll would read it back and file it as an issue.
          return ts === null
            ? Effect.fail(
                failure("chat.postMessage", { code: null, detail: "no message ts in response" }),
              )
            : Effect.succeed({ messageTs: ts });
        }),
      );

    const permalink: SlackApiClientShape["permalink"] = (input) =>
      get(
        "chat.getPermalink",
        input.token,
        { channel: input.channelId, message_ts: input.messageTs },
        PermalinkResponse,
      ).pipe(Effect.map((body) => trimToNull(body.permalink)));

    const displayName: SlackApiClientShape["displayName"] = (input) =>
      Effect.gen(function* () {
        const cached = yield* Ref.get(nameCache);
        if (cached.token === input.token && cached.names.has(input.userId)) {
          return cached.names.get(input.userId) ?? null;
        }

        const body = yield* get(
          "users.info",
          input.token,
          { user: input.userId },
          UsersInfoResponse,
        );
        const name =
          trimToNull(body.user?.profile?.display_name) ??
          trimToNull(body.user?.real_name) ??
          trimToNull(body.user?.profile?.real_name) ??
          trimToNull(body.user?.name);

        yield* Ref.update(nameCache, (current) => {
          const names =
            current.token === input.token
              ? new Map(current.names)
              : new Map<string, string | null>();
          names.set(input.userId, name);
          return { token: input.token, names };
        });
        return name;
      });

    const downloadImage: SlackApiClientShape["downloadImage"] = (input) =>
      Effect.gen(function* () {
        const maxBytes = input.maxBytes ?? SLACK_MAX_IMAGE_BYTES;
        const response = yield* execute(
          "files.download",
          HttpClientRequest.get(input.url).pipe(HttpClientRequest.bearerToken(input.token)),
        );
        if (response.status >= 400) {
          return yield* failure("files.download", { status: response.status });
        }

        const contentType =
          Option.getOrUndefined(Headers.get(response.headers, "content-type"))?.split(";")[0] ??
          undefined;
        const mimeType = (trimToNull(contentType) ?? input.declaredMimeType ?? "").toLowerCase();
        // Slack answers an unauthenticated file request with the sign-in page, HTML and all.
        if (!mimeType.startsWith("image/")) return null;

        const buffer = yield* response.arrayBuffer.pipe(
          Effect.mapError(() =>
            failure("files.download", { status: response.status, detail: "unreadable body" }),
          ),
        );
        if (buffer.byteLength === 0 || buffer.byteLength > maxBytes) return null;
        return { bytes: new Uint8Array(buffer), mimeType };
      });

    return {
      authTest,
      listChannels,
      history,
      replies,
      postToThread,
      permalink,
      displayName,
      downloadImage,
    } satisfies SlackApiClientShape;
  });

export const layer = Layer.effect(SlackApiClient, make());

/** For tests and for anything that needs the calls to run without the one-second gap. */
export const layerWith = (options: SlackApiClientOptions) =>
  Layer.effect(SlackApiClient, make(options));
