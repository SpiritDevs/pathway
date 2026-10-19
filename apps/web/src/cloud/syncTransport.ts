/**
 * The browser {@link SyncTransport}: the five Convex sync functions spoken over Convex's
 * subscribing WebSocket client.
 *
 * Two things make this the web implementation rather than a shared one. First, the head is a live
 * subscription (`client.onUpdate`) instead of a poll, which is the whole reason a tab can sit idle
 * and still be current. Second, authentication is Convex's own Clerk integration: the client is
 * handed a token fetcher and refreshes on its own schedule, so nothing here mints, caches, or
 * refreshes a token.
 *
 * Function references are built from {@link SYNC_FUNCTIONS} rather than imported from the
 * generated Convex API. The generated `api.d.ts` pulls every backend module's types (and their
 * `process.env` capability reads) into whatever project imports it; the web app deliberately has
 * no dependency on `@spiritdevs/backend`. Going through `makeFunctionReference` also lets each
 * reference carry the *contract* request/response types — branded, the same types the port
 * declares — instead of Convex's unbranded validator inference.
 *
 * @module cloud/syncTransport
 */
import { SyncTransport, SyncTransportError } from "@spiritdevs/client-runtime/sync";
import {
  SYNC_FUNCTIONS,
  type SyncApplyOperationsRequest,
  type SyncApplyOperationsResponse,
  type SyncBootstrapRequest,
  type SyncBootstrapResponse,
  type SyncLatestVersionRequest,
  type SyncLatestVersionResponse,
  type SyncListChangesRequest,
  type SyncListChangesResponse,
  type SyncReserveIssueKeysRequest,
  type SyncReserveIssueKeysResponse,
} from "@spiritdevs/contracts/cloudSync";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference, type FunctionReference } from "convex/server";
import { ConvexError } from "convex/values";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

// ---------------------------------------------------------------------------
// Function references
// ---------------------------------------------------------------------------

/**
 * Convex names a function `module:export`, while {@link SYNC_FUNCTIONS} spells the protocol with a
 * dot. The last dot is the separator: `sync.latestVersion` is the `latestVersion` export of
 * `convex/sync.ts`.
 */
export function convexFunctionName(protocolName: string): string {
  const separator = protocolName.lastIndexOf(".");
  return separator === -1
    ? protocolName
    : `${protocolName.slice(0, separator)}:${protocolName.slice(separator + 1)}`;
}

const queryReference = <Request extends ConvexArgs, Response>(protocolName: string) =>
  makeFunctionReference<"query", Request, Response>(convexFunctionName(protocolName));

const mutationReference = <Request extends ConvexArgs, Response>(protocolName: string) =>
  makeFunctionReference<"mutation", Request, Response>(convexFunctionName(protocolName));

/** One typed reference per protocol function, so a rename in the contract lands here too. */
export const SYNC_FUNCTION_REFERENCES = {
  bootstrap: queryReference<SyncBootstrapRequest, SyncBootstrapResponse>(SYNC_FUNCTIONS.bootstrap),
  latestVersion: queryReference<SyncLatestVersionRequest, SyncLatestVersionResponse>(
    SYNC_FUNCTIONS.latestVersion,
  ),
  listChanges: queryReference<SyncListChangesRequest, SyncListChangesResponse>(
    SYNC_FUNCTIONS.listChanges,
  ),
  applyOperations: mutationReference<SyncApplyOperationsRequest, SyncApplyOperationsResponse>(
    SYNC_FUNCTIONS.applyOperations,
  ),
  reserveIssueKeys: mutationReference<SyncReserveIssueKeysRequest, SyncReserveIssueKeysResponse>(
    SYNC_FUNCTIONS.reserveIssueKeys,
  ),
} as const;

// ---------------------------------------------------------------------------
// The slice of `ConvexClient` this transport uses
// ---------------------------------------------------------------------------

/** Convex accepts a plain record of `Value`s; the contract requests are exactly that shape. */
export type ConvexArgs = Record<string, unknown>;

/**
 * What Convex asks of a token source: an async fetcher it calls on its own schedule, with
 * `forceRefreshToken` set when the cached token was rejected and a fresh one is required.
 */
export type ConvexAuthTokenFetcher = (args: {
  readonly forceRefreshToken: boolean;
}) => Promise<string | null | undefined>;

/**
 * The five methods this transport needs from `ConvexClient`, written loosely enough that a test
 * fake is a plain object literal and precisely enough that the real client satisfies it.
 */
export interface ConvexClientLike {
  readonly query: (reference: FunctionReference<"query">, args: ConvexArgs) => Promise<unknown>;
  readonly mutation: (
    reference: FunctionReference<"mutation">,
    args: ConvexArgs,
  ) => Promise<unknown>;
  readonly onUpdate: (
    reference: FunctionReference<"query">,
    args: ConvexArgs,
    callback: (value: unknown) => void,
    onError?: (error: Error) => void,
  ) => () => void;
  readonly setAuth: (fetchToken: ConvexAuthTokenFetcher) => void;
  readonly close: () => Promise<void>;
}

export interface ConvexSyncTransportOptions {
  /** The deployment URL, e.g. `https://<deployment>.convex.cloud`. */
  readonly convexUrl: string;
  /** Clerk (or any) token source, handed straight to `client.setAuth`. */
  readonly fetchToken: ConvexAuthTokenFetcher;
  /**
   * Injected client, for tests and for a host that already owns a connection. When omitted a real
   * `ConvexClient` is constructed and closed with the scope; an injected one is never closed here,
   * because its lifetime belongs to whoever passed it in.
   */
  readonly client?: ConvexClientLike;
}

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

/** Backend refusals that mean "this identity may not do this", not "try again later". */
const UNAUTHORIZED_CODES = new Set([
  "not-authenticated",
  "not-a-member",
  "permission-denied",
  "user-not-provisioned",
]);

/**
 * Terminal refusals that no retry fixes and no re-authentication clears: the client is talking to
 * a deployment that will not serve it until the app itself changes.
 */
const UPGRADE_REQUIRED_CODES = new Set([
  "upgrade-required",
  "cloud-sync-disabled",
  "not-implemented",
]);

/**
 * Codes `sync.applyOperations` throws when it refuses a *whole batch* before applying anything.
 *
 * `validateOperationBatch` (`@spiritdevs/backend`'s `src/sync/operations.ts`) checks the shape of a
 * batch — its size, the bytes its arguments weigh, that every operation names the company that was
 * asked for, that no operation id repeats — and a failure there throws instead of answering with
 * per-operation receipts. None of that is a property of the connection: the outbox rebuilds the
 * same batch from the same first entries in local sequence every cycle, so a retry can only be
 * refused again while every operation queued behind it waits forever. They are therefore terminal,
 * and reported as `upgrade-required` — the reason that stops the engine and puts the deployment's
 * own message in front of the user rather than hiding a permanent stall behind a retry loop.
 *
 * `invalid-arguments` is deliberately *not* here even though the same validator can produce it:
 * `sync.bootstrap` also answers `invalid-arguments` for a page cursor it cannot decode, and
 * `decodeBootstrapCursor` says in as many words that the client is meant to restart its seed —
 * which is what the next cycle does, from a `null` cursor. Retrying is the recovery there.
 */
const BATCH_REFUSED_CODES = new Set([
  "batch-empty",
  "batch-too-large",
  "batch-args-too-large",
  "batch-duplicate-operation-id",
  "company-mismatch",
]);

const OFFLINE_PATTERN =
  /failed to fetch|load failed|networkerror|network error|network request failed|err_internet_disconnected|err_network|connection (refused|reset|closed)|websocket|offline|fetch failed/iu;

const UNAUTHORIZED_PATTERN =
  /unauthenticated|unauthorized|not authenticated|authentication failed|failed to authenticate|invalid (auth|token|jwt)|token (expired|invalid)/iu;

/** The `code` a backend `ConvexError` carries, or `null` when this is not one. */
export function convexSyncErrorCode(error: unknown): string | null {
  if (!(error instanceof ConvexError)) {
    return null;
  }
  const data: unknown = error.data;
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const code = (data as Record<string, unknown>)["code"];
  return typeof code === "string" ? code : null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  const text = String(error);
  return text.length > 0 ? text : "Convex call failed.";
}

/** True while the browser itself says there is no network; unknown environments answer `false`. */
function browserIsOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

/**
 * Maps whatever the Convex client threw onto the port's four reasons.
 *
 * A `ConvexError` wins over every heuristic: it came back from the deployment, so the call reached
 * the server and its code is the authoritative answer. Only then do the transport-level shapes
 * matter — a browser reports a dropped connection as a `TypeError: Failed to fetch`, which is
 * indistinguishable from being offline and is treated as such because both are retryable.
 */
export function classifyConvexSyncTransportError(error: unknown): SyncTransportError {
  const message = errorMessage(error);
  const code = convexSyncErrorCode(error);
  if (code !== null) {
    if (UPGRADE_REQUIRED_CODES.has(code) || BATCH_REFUSED_CODES.has(code)) {
      return new SyncTransportError({ reason: "upgrade-required", message });
    }
    return new SyncTransportError({
      reason: UNAUTHORIZED_CODES.has(code) ? "unauthorized" : "transport",
      message,
    });
  }
  if (error instanceof ConvexError) {
    return new SyncTransportError({ reason: "transport", message });
  }
  if (UNAUTHORIZED_PATTERN.test(message)) {
    return new SyncTransportError({ reason: "unauthorized", message });
  }
  if (browserIsOffline() || OFFLINE_PATTERN.test(message)) {
    return new SyncTransportError({ reason: "offline", message });
  }
  return new SyncTransportError({ reason: "transport", message });
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * Convex distinguishes an absent optional argument from a present `undefined` one, and the
 * contract's optionals (`limit`, `pageSize`, `blockSize`) are frequently spread in as explicit
 * `undefined`. Nulls are kept: `bootstrap.cursor: null` means "start a fresh seed".
 */
export function convexArgs<Request extends ConvexArgs>(request: Request): ConvexArgs {
  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(request)) {
    if (value !== undefined) {
      args[key] = value;
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

/**
 * Builds the transport over a Convex connection. Scoped: the client this constructs is closed when
 * the scope closes, so a signed-out tab does not keep a socket open.
 */
export const makeConvexSyncTransport = Effect.fn("web.convexSyncTransport.make")(function* (
  options: ConvexSyncTransportOptions,
) {
  const client: ConvexClientLike = options.client ?? new ConvexClient(options.convexUrl);
  if (options.client === undefined) {
    yield* Effect.addFinalizer(() =>
      Effect.tryPromise(() => client.close()).pipe(Effect.ignore, Effect.asVoid),
    );
  }
  client.setAuth(options.fetchToken);

  const runQuery = <Request extends ConvexArgs, Response>(
    reference: FunctionReference<"query", "public", Request, Response>,
    request: Request,
  ): Effect.Effect<Response, SyncTransportError> =>
    Effect.tryPromise({
      try: () => client.query(reference, convexArgs(request)),
      catch: classifyConvexSyncTransportError,
    }).pipe(Effect.map((value) => value as Response));

  const runMutation = <Request extends ConvexArgs, Response>(
    reference: FunctionReference<"mutation", "public", Request, Response>,
    request: Request,
  ): Effect.Effect<Response, SyncTransportError> =>
    Effect.tryPromise({
      try: () => client.mutation(reference, convexArgs(request)),
      catch: classifyConvexSyncTransportError,
    }).pipe(Effect.map((value) => value as Response));

  return SyncTransport.of({
    bootstrap: (input) =>
      runQuery(SYNC_FUNCTION_REFERENCES.bootstrap, input).pipe(
        Effect.withSpan("web.convexSyncTransport.bootstrap"),
      ),
    listChanges: (input) =>
      runQuery(SYNC_FUNCTION_REFERENCES.listChanges, input).pipe(
        Effect.withSpan("web.convexSyncTransport.listChanges"),
      ),
    applyOperations: (input) =>
      runMutation(SYNC_FUNCTION_REFERENCES.applyOperations, input).pipe(
        Effect.withSpan("web.convexSyncTransport.applyOperations"),
      ),
    reserveIssueKeys: (input) =>
      runMutation(SYNC_FUNCTION_REFERENCES.reserveIssueKeys, input).pipe(
        Effect.withSpan("web.convexSyncTransport.reserveIssueKeys"),
      ),
    /**
     * The one live subscription. Convex re-runs the callback on every new result; the dedupe below
     * is what keeps a re-delivery of the same head (a reconnect replays the current value) from
     * waking the engine for nothing.
     *
     * The queue behind the callback is a *sliding buffer of one*, because only the newest head is
     * information: every consumer of this stream reacts by syncing up to the current head, so a
     * stale head can only produce a redundant cycle. The default unbounded buffer would grow one
     * entry per backend write while the consumer is busy — a long retry, a slow bootstrap page —
     * and then make the engine replay a full cycle per accumulated head after it recovers.
     * Coalescing to the latest bounds both the memory and the catch-up work.
     *
     * `changesWith` still sits on top: sliding drops *older* heads, while the dedupe drops a
     * *repeat* of the head already delivered, which is what a reconnect replay looks like.
     */
    latestVersion: (input) =>
      Stream.callback<SyncLatestVersionResponse, SyncTransportError>(
        (queue) =>
          Effect.gen(function* () {
            const unsubscribe = client.onUpdate(
              SYNC_FUNCTION_REFERENCES.latestVersion,
              convexArgs(input),
              (value) => {
                Queue.offerUnsafe(queue, value as SyncLatestVersionResponse);
              },
              (error) => {
                Queue.failCauseUnsafe(queue, Cause.fail(classifyConvexSyncTransportError(error)));
              },
            );
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                unsubscribe();
              }),
            );
          }),
        { bufferSize: 1, strategy: "sliding" },
      ).pipe(
        Stream.changesWith(
          (left, right) =>
            left.version === right.version && left.authorizationEpoch === right.authorizationEpoch,
        ),
      ),
  });
});

/**
 * The transport as a layer. Nothing constructs it unless a host composes it, which keeps cloud
 * sync default-off: no Convex socket is opened by importing this module.
 */
export const convexSyncTransportLayer = (
  options: ConvexSyncTransportOptions,
): Layer.Layer<SyncTransport> => Layer.effect(SyncTransport)(makeConvexSyncTransport(options));
