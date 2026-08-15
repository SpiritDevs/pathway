/**
 * The Pathway server's implementation of the cloud-sync {@link SyncTransport} port over Convex.
 *
 * `@spiritdevs/client-runtime`'s sync engine never imports a Convex client: it asks a platform for
 * the five functions `SYNC_FUNCTIONS` names and nothing else. This module is the server's answer,
 * assembled out of the same pieces the Phase-1 smoke run proved end to end — the relay-minted
 * `pathway-convex` service token from `./convexServiceToken.ts` and a `ConvexHttpClient` against the
 * deployment.
 *
 * Two things are deliberately different from a browser client:
 *
 * - **`latestVersion` polls.** `ConvexHttpClient` has no subscriptions, so the one query a client
 *   would normally subscribe to is polled on a schedule and deduplicated, which is why the engine
 *   cannot tell the difference: it only ever sees a version that actually moved.
 * - **Calls are serialized.** A `ConvexHttpClient`'s bearer token is client-wide mutable state, so
 *   the token is installed and the call issued under one permit. Concurrent calls would otherwise
 *   race to overwrite each other's `setAuth` during a refresh.
 *
 * Nothing here is wired into the running server by this module; the daemon that owns a company's
 * engine (`./syncDaemon.ts`) calls {@link makeConvexSyncTransport} behind the cloud-sync
 * capability gate. {@link convexSyncTransportLayer} packages the same constructor for callers
 * that want the transport as a `Layer`.
 *
 * @module cloud/convexSyncTransport
 */
import { api } from "@spiritdevs/backend/convexApi";
import type {
  SyncActor,
  SyncApplyOperationsResponse,
  SyncBootstrapResponse,
  SyncLatestVersionResponse,
  SyncListChangesResponse,
  SyncOperationEnvelope,
  SyncReserveIssueKeysResponse,
} from "@spiritdevs/contracts/cloudSync";
import { SyncTransport, SyncTransportError } from "@spiritdevs/client-runtime/sync";
import { ConvexHttpClient } from "convex/browser";
import { ConvexError } from "convex/values";
import type { FunctionArgs, FunctionReference, FunctionReturnType } from "convex/server";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { convexErrorCode, type ConvexServiceTokenProvider } from "./convexServiceToken.ts";

// --------------------------------------------------------------------------
// Convex client seam
// --------------------------------------------------------------------------

/**
 * The two-and-a-half methods of `ConvexHttpClient` this transport uses.
 *
 * It exists so the unit tests can drive every branch — argument shapes, error classification, the
 * 401 retry — against a fake, and so a real `ConvexHttpClient` (which opens sockets from its
 * constructor onward) is built only on the default path.
 */
export interface ConvexClientLike {
  /** Installs the bearer token presented on subsequent calls. */
  readonly setAuth: (token: string) => void;
  readonly query: <Reference extends FunctionReference<"query">>(
    reference: Reference,
    args: FunctionArgs<Reference>,
  ) => Promise<FunctionReturnType<Reference>>;
  readonly mutation: <Reference extends FunctionReference<"mutation">>(
    reference: Reference,
    args: FunctionArgs<Reference>,
  ) => Promise<FunctionReturnType<Reference>>;
}

/** Wraps a real `ConvexHttpClient` as a {@link ConvexClientLike}. The only place one is built. */
export function convexHttpClientLike(convexUrl: string): ConvexClientLike {
  const client = new ConvexHttpClient(convexUrl);
  return {
    setAuth: (token) => {
      client.setAuth(token);
    },
    query: (reference, args) => client.query(reference, args),
    mutation: (reference, args) => client.mutation(reference, args),
  };
}

// --------------------------------------------------------------------------
// Error classification
// --------------------------------------------------------------------------

/**
 * Backend codes that mean this caller is not allowed through, today, with these credentials. All
 * of them are terminal for the engine: retrying the same call with the same token cannot change
 * the answer, and the app has to re-authorize, re-link, or pick another company.
 */
const UNAUTHORIZED_CODES: ReadonlySet<string> = new Set([
  "not-authenticated",
  "not-a-member",
  "permission-denied",
  "user-not-provisioned",
  "company-not-found",
  "company-unavailable",
  "environment-not-registered",
  "environment-key-mismatch",
]);

/**
 * Codes that mean this *build* cannot talk to this deployment: either the deployment has cloud
 * sync switched off, or it refuses the protocol version this client speaks. Both surface as
 * `upgrade-required`, the transport's "stop and tell the user" reason, rather than as a retry loop
 * that would hammer a deployment which will never answer differently.
 */
const UPGRADE_REQUIRED_CODES: ReadonlySet<string> = new Set([
  "cloud-sync-disabled",
  "upgrade-required",
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
 * own message in front of the user rather than hiding a permanent stall behind "offline".
 *
 * `invalid-arguments` is deliberately *not* here even though the same validator can produce it:
 * `sync.bootstrap` also answers `invalid-arguments` for a page cursor it cannot decode, and
 * `decodeBootstrapCursor` says in as many words that the client is meant to restart its seed —
 * which is what the next cycle does, from a `null` cursor. Retrying is the recovery there.
 */
const BATCH_REFUSED_CODES: ReadonlySet<string> = new Set([
  "batch-empty",
  "batch-too-large",
  "batch-args-too-large",
  "batch-duplicate-operation-id",
  "company-mismatch",
]);

/** Node/undici error codes that mean the request never reached the deployment. */
const OFFLINE_SYSTEM_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

/** Walks an error's `cause` chain looking for a system code, which is where undici hides its own. */
function systemErrorCode(error: unknown): string | null {
  let current: unknown = error;
  for (let depth = 0; current !== null && current !== undefined && depth < 5; depth += 1) {
    if (typeof current === "object") {
      const code = (current as { readonly code?: unknown }).code;
      if (typeof code === "string" && code.length > 0) return code;
      current = (current as { readonly cause?: unknown }).cause;
      continue;
    }
    break;
  }
  return null;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * Maps whatever a Convex call threw onto one of the four transport reasons.
 *
 * A `ConvexError` is a decision the deployment reached, so its code decides. Anything else is a
 * failure of the pipe: a name that would not resolve or a socket that would not open is `offline`
 * (retryable, the replica is intact), an HTTP 401/403 from Convex's own auth layer — before any
 * handler ran — is `unauthorized`, and everything left is `transport`.
 *
 * `transport` is the retryable default on purpose: a code this build has never heard of is still a
 * decision, and the deployment is the one that changes. The code sets above are what pulls a code
 * out of that default, and they are hand-maintained — a backend code that becomes permanent has to
 * be named there, which is why each set says what makes its members permanent.
 */
export function classifyConvexFailure(error: unknown): SyncTransportError["reason"] {
  const code = convexErrorCode(error);
  if (code !== null) {
    if (UPGRADE_REQUIRED_CODES.has(code)) return "upgrade-required";
    if (BATCH_REFUSED_CODES.has(code)) return "upgrade-required";
    if (UNAUTHORIZED_CODES.has(code)) return "unauthorized";
    return "transport";
  }
  // A `ConvexError` whose payload is not a backend error is still a deployment decision.
  if (error instanceof ConvexError) return "transport";

  const systemCode = systemErrorCode(error);
  if (systemCode !== null && OFFLINE_SYSTEM_CODES.has(systemCode)) return "offline";

  const message = errorMessage(error).toLowerCase();
  if (
    message.includes("fetch failed") ||
    message.includes("network error") ||
    message.includes("failed to fetch")
  ) {
    return "offline";
  }
  if (
    message.includes("401") ||
    message.includes("403") ||
    message.includes("unauthorized") ||
    message.includes("unauthenticated")
  ) {
    return "unauthorized";
  }
  return "transport";
}

function toTransportError(error: unknown): SyncTransportError {
  return new SyncTransportError({
    reason: classifyConvexFailure(error),
    message: errorMessage(error),
  });
}

// --------------------------------------------------------------------------
// Argument marshalling
// --------------------------------------------------------------------------

type ApplyOperationsArgs = FunctionArgs<typeof api.sync.applyOperations>;
type OperationArg = ApplyOperationsArgs["operations"][number];

/**
 * The wire form of one operation.
 *
 * Written out field by field rather than spread, because the Convex validator's inferred type is
 * mutable and the contract's is not: a spread would compile only by widening, and an envelope that
 * grew a field the validator does not accept would be discovered by the deployment refusing the
 * whole batch instead of by the compiler here.
 */
function toOperationArg(envelope: SyncOperationEnvelope): OperationArg {
  return {
    protocolVersion: envelope.protocolVersion,
    operationId: envelope.operationId,
    companyId: envelope.companyId,
    clientId: envelope.clientId,
    environmentId: envelope.environmentId,
    actor: toActorArg(envelope.actor),
    localSequence: envelope.localSequence,
    baseVersion: envelope.baseVersion,
    kind: envelope.kind,
    entityId: envelope.entityId,
    args: envelope.args,
    dependsOn: [...envelope.dependsOn],
  };
}

/**
 * Reattaches the contract type to a validated Convex result.
 *
 * Convex checks every response against the `returns` validator its function declares, and those
 * validators mirror `contracts/cloudSync` field for field (`convex/lib/validators.ts` says so and
 * says which file changes when they disagree). What is left over is branding, which no runtime
 * carries. Re-decoding here would be actively worse: the change envelope's `entityKind` is a closed
 * literal set in the contract but an open string on the wire precisely so a build that meets a kind
 * it does not know drops that row, and a strict decode would instead fail the whole page.
 */
const asContract = <A>(result: unknown): A => result as A;

function toActorArg(actor: SyncActor): OperationArg["actor"] {
  switch (actor.kind) {
    case "member":
      return { kind: "member", membershipId: actor.membershipId };
    case "agent":
      return {
        kind: "agent",
        provider: actor.provider,
        onBehalfOfMembershipId: actor.onBehalfOfMembershipId,
      };
    case "system":
      return { kind: "system", source: actor.source };
    case "environment":
      return { kind: "environment", environmentId: actor.environmentId };
  }
}

// --------------------------------------------------------------------------
// Transport
// --------------------------------------------------------------------------

/**
 * How often `latestVersion` is polled when nothing else prompts a sync. Fifteen seconds is the
 * upper bound on how stale a passive replica gets; a local write syncs immediately through the
 * engine's own flush rather than waiting for the next tick.
 */
export const DEFAULT_LATEST_VERSION_POLL_INTERVAL_MS = 15_000;

export interface ConvexSyncTransportOptions {
  /** Deployment URL. Ignored when {@link client} is supplied. */
  readonly convexUrl: string;
  /** Mints and caches the `pathway-convex` service token every call presents. */
  readonly tokens: ConvexServiceTokenProvider;
  /** Injected client seam; the default builds a real `ConvexHttpClient` over {@link convexUrl}. */
  readonly client?: ConvexClientLike;
  /** Defaults to {@link DEFAULT_LATEST_VERSION_POLL_INTERVAL_MS}. */
  readonly pollIntervalMs?: number;
}

export const makeConvexSyncTransport = Effect.fn("cloud.convex_sync_transport.make")(function* (
  options: ConvexSyncTransportOptions,
) {
  const client = options.client ?? convexHttpClientLike(options.convexUrl);
  const tokens = options.tokens;
  const pollInterval = Duration.millis(
    options.pollIntervalMs ?? DEFAULT_LATEST_VERSION_POLL_INTERVAL_MS,
  );
  // One permit, because `setAuth` is client-wide mutable state: two calls in flight during a token
  // refresh would otherwise race to decide which token the other one presents.
  const callLock = yield* Semaphore.make(1);

  const serviceToken: Effect.Effect<string, SyncTransportError> = tokens.token.pipe(
    Effect.mapError(
      (error) => new SyncTransportError({ reason: error.reason, message: error.message }),
    ),
  );

  const issue = <A>(token: string, call: (client: ConvexClientLike) => Promise<A>) =>
    callLock.withPermits(1)(
      Effect.suspend(() => {
        client.setAuth(token);
        return Effect.tryPromise({ try: () => call(client), catch: toTransportError });
      }),
    );

  /**
   * Runs one Convex call with a current token, and retries exactly once on an authorization
   * failure with a freshly minted one.
   *
   * The retry is what makes a token that expired in flight — or one the relay rotated out from
   * under a long-idle daemon — invisible to the engine. It is deliberately once: a second refusal
   * is a real authorization answer, and looping on it would spin against the deployment.
   */
  const authorized = <A>(
    call: (client: ConvexClientLike) => Promise<A>,
  ): Effect.Effect<A, SyncTransportError> =>
    Effect.gen(function* () {
      const token = yield* serviceToken;
      return yield* issue(token, call).pipe(
        Effect.catchIf(
          (error) => error.reason === "unauthorized",
          () =>
            tokens.invalidate(token).pipe(
              Effect.andThen(serviceToken),
              Effect.flatMap((refreshed) => issue(refreshed, call)),
            ),
        ),
      );
    });

  const latestVersionOnce = (
    companyId: string,
  ): Effect.Effect<SyncLatestVersionResponse, SyncTransportError> =>
    authorized((convex) => convex.query(api.sync.latestVersion, { companyId })).pipe(
      Effect.map(asContract<SyncLatestVersionResponse>),
    );

  return SyncTransport.of({
    bootstrap: (input) =>
      authorized((convex) =>
        convex.query(api.sync.bootstrap, {
          companyId: input.companyId,
          cursor: input.cursor,
          ...(input.pageSize === undefined ? {} : { pageSize: input.pageSize }),
        }),
      ).pipe(Effect.map(asContract<SyncBootstrapResponse>)),

    /**
     * The subscription the engine believes it has. `ConvexHttpClient` cannot subscribe, so the head
     * is polled on {@link ConvexSyncTransportOptions.pollIntervalMs} and deduplicated: the first
     * read is emitted immediately so a starting engine syncs at once, and every later tick is
     * emitted only when the version or the authorization epoch actually moved. Without the
     * deduplication the engine would run a full sync pass every interval forever.
     */
    latestVersion: (input) =>
      Stream.fromEffectSchedule(
        latestVersionOnce(input.companyId),
        Schedule.spaced(pollInterval),
      ).pipe(
        Stream.changesWith(
          (previous, next) =>
            previous.version === next.version &&
            previous.authorizationEpoch === next.authorizationEpoch,
        ),
      ),

    listChanges: (input) =>
      authorized((convex) =>
        convex.query(api.sync.listChanges, {
          companyId: input.companyId,
          cursor: input.cursor,
          ...(input.limit === undefined ? {} : { limit: input.limit }),
        }),
      ).pipe(Effect.map(asContract<SyncListChangesResponse>)),

    applyOperations: (input) =>
      authorized((convex) =>
        convex.mutation(api.sync.applyOperations, {
          companyId: input.companyId,
          operations: input.operations.map(toOperationArg),
        }),
      ).pipe(Effect.map(asContract<SyncApplyOperationsResponse>)),

    reserveIssueKeys: (input) =>
      authorized((convex) =>
        convex.mutation(api.sync.reserveIssueKeys, {
          companyId: input.companyId,
          clientId: input.clientId,
          ...(input.blockSize === undefined ? {} : { blockSize: input.blockSize }),
        }),
      ).pipe(Effect.map(asContract<SyncReserveIssueKeysResponse>)),
  });
});

export const convexSyncTransportLayer = (
  options: ConvexSyncTransportOptions,
): Layer.Layer<SyncTransport> => Layer.effect(SyncTransport, makeConvexSyncTransport(options));
