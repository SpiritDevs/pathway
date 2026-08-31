import type { ServerProviderAuthenticationStartResult } from "@spiritdevs/contracts";
import * as Crypto from "effect/Crypto";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

const AUTHENTICATION_FLOW_TTL = Duration.minutes(10);
const AUTHENTICATION_COMPLETION_TIMEOUT = Duration.minutes(2);

export class ProviderAuthenticationError extends Data.TaggedError("ProviderAuthenticationError")<{
  readonly reason: string;
  readonly cause?: unknown;
}> {}

export interface ProviderAuthenticationQuery {
  readonly start: () => Promise<{
    readonly authorizationUrl: string;
    readonly state: string;
    readonly completion?: "browser";
    readonly userCode?: string;
  }>;
  readonly complete: (authorizationCode: string, state: string) => Promise<void>;
  readonly close: () => void;
}

export interface ProviderAuthenticationOptions {
  readonly providerName: string;
  readonly allowedAuthorizationHosts: ReadonlySet<string>;
}

export interface ProviderAuthenticationShape {
  readonly start: Effect.Effect<
    ServerProviderAuthenticationStartResult,
    ProviderAuthenticationError
  >;
  readonly complete: (input: {
    readonly flowId: string;
    readonly authorizationCode?: string;
  }) => Effect.Effect<void, ProviderAuthenticationError>;
  readonly cancel: (flowId: string) => Effect.Effect<void>;
}

interface ActiveAuthenticationFlow {
  readonly id: string;
  readonly state: string;
  readonly completion: "authorization-code" | "browser";
  readonly query: ProviderAuthenticationQuery;
}

function authenticationError(reason: string, cause?: unknown) {
  return new ProviderAuthenticationError({ reason, ...(cause === undefined ? {} : { cause }) });
}

function parseAuthorizationUrl(value: string, allowedHosts: ReadonlySet<string>): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || !allowedHosts.has(url.hostname)) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

export const makeProviderAuthentication = Effect.fn("makeProviderAuthentication")(function* (
  createQuery: Effect.Effect<ProviderAuthenticationQuery, ProviderAuthenticationError>,
  options: ProviderAuthenticationOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Scope.Scope;
  const lock = yield* Semaphore.make(1);
  const activeFlow = yield* Ref.make<ActiveAuthenticationFlow | null>(null);

  const closeFlow = (flow: ActiveAuthenticationFlow | null) =>
    Effect.sync(() => {
      flow?.query.close();
    });

  const clearActiveFlow = Effect.fn("clearProviderAuthenticationFlow")(function* () {
    const flow = yield* Ref.getAndSet(activeFlow, null);
    yield* closeFlow(flow);
  });

  yield* Effect.addFinalizer(clearActiveFlow);

  const expireFlow = (flowId: string) =>
    lock.withPermits(1)(
      Ref.modify(activeFlow, (flow) => (flow?.id === flowId ? [flow, null] : [null, flow])).pipe(
        Effect.flatMap(closeFlow),
      ),
    );

  const start = lock.withPermits(1)(
    Effect.gen(function* () {
      yield* clearActiveFlow();
      const query = yield* createQuery;
      const result = yield* Effect.tryPromise({
        try: () => query.start(),
        catch: (cause) =>
          cause instanceof ProviderAuthenticationError
            ? cause
            : authenticationError(`${options.providerName} sign-in could not be started.`, cause),
      }).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            query.close();
          }),
        ),
      );
      const authorizationUrl = parseAuthorizationUrl(
        result.authorizationUrl,
        options.allowedAuthorizationHosts,
      );
      const state = result.state.trim();
      const userCode = result.userCode?.trim();
      if (!authorizationUrl || !state || (result.completion === "browser" && !userCode)) {
        query.close();
        return yield* authenticationError(
          `${options.providerName} returned invalid sign-in details. Update the provider and try again.`,
        );
      }

      const flowId = yield* crypto.randomUUIDv4.pipe(
        Effect.mapError((cause) => authenticationError("Could not create a sign-in flow.", cause)),
      );
      const flow: ActiveAuthenticationFlow = {
        id: flowId,
        state,
        completion: result.completion ?? "authorization-code",
        query,
      };
      yield* Ref.set(activeFlow, flow);
      yield* Effect.sleep(AUTHENTICATION_FLOW_TTL).pipe(
        Effect.andThen(expireFlow(flowId)),
        Effect.forkIn(scope),
      );
      return {
        flowId,
        authorizationUrl,
        ...(result.completion === "browser" ? { completion: "browser" as const } : {}),
        ...(userCode ? { userCode } : {}),
      } satisfies ServerProviderAuthenticationStartResult;
    }),
  );

  const complete: ProviderAuthenticationShape["complete"] = (input) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const flow = yield* Ref.get(activeFlow);
        if (!flow || flow.id !== input.flowId) {
          return yield* authenticationError(
            "This sign-in flow has expired. Start a new sign-in and try again.",
          );
        }
        const authorizationCode = input.authorizationCode?.trim() ?? "";
        if (flow.completion === "authorization-code" && !authorizationCode) {
          return yield* authenticationError(
            `Enter the authorization code from ${options.providerName}.`,
          );
        }
        const completion = yield* Effect.tryPromise({
          try: () => flow.query.complete(authorizationCode, flow.state),
          catch: (cause) =>
            cause instanceof ProviderAuthenticationError
              ? cause
              : authenticationError(
                  `${options.providerName} could not finish signing in. Check the sign-in details and try again.`,
                  cause,
                ),
        }).pipe(Effect.timeoutOption(AUTHENTICATION_COMPLETION_TIMEOUT));
        if (Option.isNone(completion)) {
          yield* Ref.set(activeFlow, null);
          yield* closeFlow(flow);
          return yield* authenticationError(
            `${options.providerName} sign-in timed out. Start a new sign-in and try again.`,
          );
        }
        yield* Ref.set(activeFlow, null);
        yield* closeFlow(flow);
      }),
    );

  const cancel: ProviderAuthenticationShape["cancel"] = (flowId) => expireFlow(flowId);

  return {
    start,
    complete,
    cancel,
  } satisfies ProviderAuthenticationShape;
});
