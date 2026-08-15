import { describe, expect, it } from "@effect/vitest";
import { SyncTransport } from "@spiritdevs/client-runtime/sync";
import { CompanyId } from "@spiritdevs/contracts/company";
import {
  AuthorizationEpoch,
  CompanyVersion,
  LocalSequence,
  SyncClientId,
  SyncEntityId,
  SyncOperationId,
  SYNC_PROTOCOL_VERSION,
  type SyncApplyOperationsResponse,
  type SyncOperationEnvelope,
  type SyncBootstrapResponse,
  type SyncLatestVersionResponse,
  type SyncListChangesResponse,
  type SyncReserveIssueKeysResponse,
} from "@spiritdevs/contracts/cloudSync";
import { getFunctionName } from "convex/server";
import { ConvexError } from "convex/values";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import {
  classifyConvexSyncTransportError,
  convexArgs,
  convexFunctionName,
  convexSyncTransportLayer,
  makeConvexSyncTransport,
  SYNC_FUNCTION_REFERENCES,
  type ConvexArgs,
  type ConvexAuthTokenFetcher,
  type ConvexClientLike,
} from "./syncTransport";

const COMPANY_ID = CompanyId.make("company-1");

const head = (version: number, epoch = 1): SyncLatestVersionResponse => ({
  version: CompanyVersion.make(version),
  authorizationEpoch: AuthorizationEpoch.make(epoch),
});

const OPERATION: SyncOperationEnvelope = {
  protocolVersion: SYNC_PROTOCOL_VERSION,
  operationId: SyncOperationId.make("operation-1"),
  companyId: COMPANY_ID,
  clientId: SyncClientId.make("client-1"),
  environmentId: null,
  actor: { kind: "member", membershipId: "membership-1" } as SyncOperationEnvelope["actor"],
  localSequence: LocalSequence.make(1),
  baseVersion: CompanyVersion.make(7),
  entityId: SyncEntityId.make("entity-1"),
  dependsOn: [],
  kind: "issueLabel.create" as SyncOperationEnvelope["kind"],
  args: { name: "label", color: "#0ea5e9" },
};

interface RecordedCall {
  readonly kind: "query" | "mutation";
  readonly name: string;
  readonly args: ConvexArgs;
}

interface RecordedSubscription {
  readonly name: string;
  readonly args: ConvexArgs;
  readonly emit: (value: unknown) => void;
  readonly fail: (error: Error) => void;
  unsubscribed: number;
}

interface FakeConvexClient {
  readonly client: ConvexClientLike;
  readonly calls: ReadonlyArray<RecordedCall>;
  readonly subscriptions: ReadonlyArray<RecordedSubscription>;
  readonly authFetchers: ReadonlyArray<ConvexAuthTokenFetcher>;
  readonly closes: () => number;
  /** Resolves once the first `onUpdate` registration has landed. */
  readonly subscribed: Promise<void>;
}

const makeFakeConvexClient = (
  answer: (call: RecordedCall) => unknown = () => undefined,
): FakeConvexClient => {
  const calls: Array<RecordedCall> = [];
  const subscriptions: Array<RecordedSubscription> = [];
  const authFetchers: Array<ConvexAuthTokenFetcher> = [];
  let closes = 0;
  let markSubscribed: () => void = () => {};
  const subscribed = new Promise<void>((resolve) => {
    markSubscribed = resolve;
  });

  const record = (kind: "query" | "mutation", name: string, args: ConvexArgs) => {
    const call: RecordedCall = { kind, name, args };
    calls.push(call);
    const result = answer(call);
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
  };

  const client: ConvexClientLike = {
    query: (reference, args) => record("query", getFunctionName(reference), args),
    mutation: (reference, args) => record("mutation", getFunctionName(reference), args),
    onUpdate: (reference, args, callback, onError) => {
      const subscription: RecordedSubscription = {
        name: getFunctionName(reference),
        args,
        emit: (value) => {
          callback(value);
        },
        fail: (error) => {
          onError?.(error);
        },
        unsubscribed: 0,
      };
      subscriptions.push(subscription);
      markSubscribed();
      return () => {
        subscription.unsubscribed += 1;
      };
    },
    setAuth: (fetchToken) => {
      authFetchers.push(fetchToken);
    },
    close: () => {
      closes += 1;
      return Promise.resolve();
    },
  };

  return { client, calls, subscriptions, authFetchers, closes: () => closes, subscribed };
};

/** Builds the transport over a fake client inside a scope the test controls. */
const withTransport = <A, E>(
  fake: FakeConvexClient,
  use: (transport: SyncTransport["Service"]) => Effect.Effect<A, E>,
  fetchToken: ConvexAuthTokenFetcher = () => Promise.resolve("token"),
) =>
  Effect.scoped(
    makeConvexSyncTransport({
      convexUrl: "https://example.convex.cloud",
      fetchToken,
      client: fake.client,
    }).pipe(Effect.flatMap(use)),
  );

describe("convexFunctionName", () => {
  it("turns the protocol's dotted name into Convex's module:export form", () => {
    expect(convexFunctionName("sync.latestVersion")).toBe("sync:latestVersion");
    expect(convexFunctionName("lib/sync.listChanges")).toBe("lib/sync:listChanges");
    expect(convexFunctionName("sync")).toBe("sync");
  });

  it("names every reference the transport calls", () => {
    expect(getFunctionName(SYNC_FUNCTION_REFERENCES.bootstrap)).toBe("sync:bootstrap");
    expect(getFunctionName(SYNC_FUNCTION_REFERENCES.latestVersion)).toBe("sync:latestVersion");
    expect(getFunctionName(SYNC_FUNCTION_REFERENCES.listChanges)).toBe("sync:listChanges");
    expect(getFunctionName(SYNC_FUNCTION_REFERENCES.applyOperations)).toBe("sync:applyOperations");
    expect(getFunctionName(SYNC_FUNCTION_REFERENCES.reserveIssueKeys)).toBe(
      "sync:reserveIssueKeys",
    );
  });
});

describe("convexArgs", () => {
  it("drops absent optionals and keeps nulls", () => {
    expect(convexArgs({ companyId: COMPANY_ID, cursor: null, pageSize: undefined })).toEqual({
      companyId: COMPANY_ID,
      cursor: null,
    });
  });
});

describe("classifyConvexSyncTransportError", () => {
  it("maps backend refusal codes onto the port's reasons", () => {
    const refusal = (code: string) =>
      classifyConvexSyncTransportError(new ConvexError({ code, message: "refused" })).reason;
    expect(refusal("not-authenticated")).toBe("unauthorized");
    expect(refusal("not-a-member")).toBe("unauthorized");
    expect(refusal("permission-denied")).toBe("unauthorized");
    expect(refusal("user-not-provisioned")).toBe("unauthorized");
    expect(refusal("upgrade-required")).toBe("upgrade-required");
    expect(refusal("cloud-sync-disabled")).toBe("upgrade-required");
    expect(refusal("invalid-arguments")).toBe("transport");
  });

  it("reports a batch the deployment refused whole as terminal, not as retryable transport", () => {
    // The outbox rebuilds the identical batch every cycle, so retrying one of these can only be
    // refused again while every queued operation behind it waits forever. They must stop the
    // engine the way the server transport's BATCH_REFUSED_CODES already do.
    const refusal = (code: string) =>
      classifyConvexSyncTransportError(new ConvexError({ code, message: "refused" })).reason;
    expect(refusal("batch-empty")).toBe("upgrade-required");
    expect(refusal("batch-too-large")).toBe("upgrade-required");
    expect(refusal("batch-args-too-large")).toBe("upgrade-required");
    expect(refusal("batch-duplicate-operation-id")).toBe("upgrade-required");
    expect(refusal("company-mismatch")).toBe("upgrade-required");
    // A cursor the backend cannot decode also answers invalid-arguments, and the recovery there is
    // the next cycle's fresh seed — so it stays retryable on purpose.
    expect(refusal("invalid-arguments")).toBe("transport");
  });

  it("treats a ConvexError without a code as transport trouble, not as offline", () => {
    const error = classifyConvexSyncTransportError(new ConvexError("something failed to fetch"));
    expect(error.reason).toBe("transport");
  });

  it("reads browser network failures as offline and auth failures as unauthorized", () => {
    expect(classifyConvexSyncTransportError(new TypeError("Failed to fetch")).reason).toBe(
      "offline",
    );
    expect(classifyConvexSyncTransportError(new Error("NetworkError when attempting")).reason).toBe(
      "offline",
    );
    expect(
      classifyConvexSyncTransportError(new Error("Convex: Unauthenticated call to sync:bootstrap"))
        .reason,
    ).toBe("unauthorized");
    expect(classifyConvexSyncTransportError(new Error("boom")).reason).toBe("transport");
    expect(classifyConvexSyncTransportError("boom").message).toBe("boom");
  });
});

describe("ConvexSyncTransport", () => {
  it.effect("hands Convex the caller's token fetcher, forceRefreshToken included", () =>
    Effect.gen(function* () {
      const fake = makeFakeConvexClient();
      const seen: Array<boolean> = [];
      yield* withTransport(
        fake,
        () =>
          Effect.promise(async () => {
            const [fetchToken] = fake.authFetchers;
            expect(fetchToken).toBeDefined();
            return await fetchToken!({ forceRefreshToken: true });
          }).pipe(
            Effect.map((token) => {
              expect(token).toBe("token");
            }),
          ),
        ({ forceRefreshToken }) => {
          seen.push(forceRefreshToken);
          return Promise.resolve("token");
        },
      );
      expect(fake.authFetchers).toHaveLength(1);
      expect(seen).toEqual([true]);
    }),
  );

  it.effect("never closes an injected client", () =>
    Effect.gen(function* () {
      const fake = makeFakeConvexClient();
      yield* withTransport(fake, () => Effect.void);
      expect(fake.closes()).toBe(0);
    }),
  );

  it.effect("calls each function with the request as its arguments", () =>
    Effect.gen(function* () {
      const bootstrapResponse: SyncBootstrapResponse = {
        version: CompanyVersion.make(7),
        authorizationEpoch: AuthorizationEpoch.make(1),
        entities: [],
        cursor: null,
        isDone: true,
      };
      const listChangesResponse: SyncListChangesResponse = {
        _tag: "CursorExpired",
        latestVersion: CompanyVersion.make(9),
        authorizationEpoch: AuthorizationEpoch.make(1),
      };
      const applyResponse: SyncApplyOperationsResponse = {
        receipts: [],
        versionFrom: CompanyVersion.make(7),
        versionTo: CompanyVersion.make(7),
        authorizationEpoch: AuthorizationEpoch.make(1),
      };
      const keysResponse: SyncReserveIssueKeysResponse = {
        prefix: "PW",
        blockStart: 1,
        blockEnd: 25,
        firstKey: "PW-1",
      } as SyncReserveIssueKeysResponse;
      const fake = makeFakeConvexClient((call) => {
        switch (call.name) {
          case "sync:bootstrap":
            return bootstrapResponse;
          case "sync:listChanges":
            return listChangesResponse;
          case "sync:applyOperations":
            return applyResponse;
          case "sync:reserveIssueKeys":
            return keysResponse;
          default:
            return undefined;
        }
      });

      yield* withTransport(fake, (transport) =>
        Effect.gen(function* () {
          expect(
            yield* transport.bootstrap({
              companyId: COMPANY_ID,
              cursor: null,
              pageSize: undefined,
            }),
          ).toEqual(bootstrapResponse);
          expect(
            yield* transport.listChanges({
              companyId: COMPANY_ID,
              cursor: CompanyVersion.make(3),
              limit: 50,
            }),
          ).toEqual(listChangesResponse);
          expect(
            yield* transport.applyOperations({
              companyId: COMPANY_ID,
              operations: [OPERATION],
            }),
          ).toEqual(applyResponse);
          expect(
            yield* transport.reserveIssueKeys({
              companyId: COMPANY_ID,
              clientId: SyncClientId.make("client-1"),
            }),
          ).toEqual(keysResponse);
        }),
      );

      expect(fake.calls.map((call) => [call.kind, call.name])).toEqual([
        ["query", "sync:bootstrap"],
        ["query", "sync:listChanges"],
        ["mutation", "sync:applyOperations"],
        ["mutation", "sync:reserveIssueKeys"],
      ]);
      // The absent optionals are absent, not present-and-undefined, and `null` survives.
      expect(fake.calls[0]?.args).toEqual({ companyId: COMPANY_ID, cursor: null });
      expect(fake.calls[1]?.args).toEqual({ companyId: COMPANY_ID, cursor: 3, limit: 50 });
      expect(fake.calls[3]?.args).toEqual({ companyId: COMPANY_ID, clientId: "client-1" });
    }),
  );

  it.effect("maps a rejected call onto a transport error", () =>
    Effect.gen(function* () {
      const fake = makeFakeConvexClient(
        () => new ConvexError({ code: "not-a-member", message: "You are not a member." }),
      );
      const error = yield* withTransport(fake, (transport) =>
        transport.listChanges({ companyId: COMPANY_ID, cursor: CompanyVersion.make(0) }),
      ).pipe(Effect.flip);
      expect(error.reason).toBe("unauthorized");
      expect(error.message).toContain("You are not a member.");
    }),
  );

  it.effect("emits every distinct head a keeping-up consumer is handed", () =>
    Effect.gen(function* () {
      const fake = makeFakeConvexClient();
      yield* withTransport(fake, (transport) =>
        Effect.gen(function* () {
          const inbox = yield* Queue.unbounded<SyncLatestVersionResponse>();
          const running = yield* Effect.forkChild(
            Stream.runForEach(transport.latestVersion({ companyId: COMPANY_ID }), (value) =>
              Queue.offer(inbox, value),
            ),
            { startImmediately: true },
          );
          yield* Effect.promise(() => fake.subscribed);
          const subscription = fake.subscriptions[0]!;
          expect(subscription.name).toBe("sync:latestVersion");
          expect(subscription.args).toEqual({ companyId: COMPANY_ID });

          subscription.emit(head(4));
          expect(yield* Queue.take(inbox)).toEqual(head(4));

          // A reconnect replays the head the tab already has; that must not wake the engine.
          subscription.emit(head(4));
          yield* Effect.replicateEffect(Effect.yieldNow, 8);
          expect(yield* Queue.size(inbox)).toBe(0);

          subscription.emit(head(5));
          expect(yield* Queue.take(inbox)).toEqual(head(5));

          yield* Fiber.interrupt(running);
          expect(subscription.unsubscribed).toBe(1);
        }),
      );
    }),
  );

  it.effect("coalesces a burst of heads to the newest while the consumer is busy", () =>
    Effect.gen(function* () {
      // Convex pushes a result per backend write, and the engine runs a whole sync cycle per
      // emission. With the default unbounded buffer a burst — or any write arriving while a cycle
      // is stuck retrying — queues one stale head per write and makes the engine replay a
      // redundant cycle for each of them once it recovers. Only the newest head carries
      // information, so the buffer keeps exactly that one.
      const fake = makeFakeConvexClient();
      yield* withTransport(fake, (transport) =>
        Effect.gen(function* () {
          const observed: Array<SyncLatestVersionResponse> = [];
          const cycleStarted = yield* Deferred.make<void>();
          const releaseCycle = yield* Deferred.make<void>();
          const running = yield* Effect.forkChild(
            Stream.runForEach(
              Stream.take(transport.latestVersion({ companyId: COMPANY_ID }), 2),
              (value) =>
                Effect.gen(function* () {
                  observed.push(value);
                  if (observed.length === 1) {
                    yield* Deferred.succeed(cycleStarted, undefined);
                    yield* Deferred.await(releaseCycle);
                  }
                }),
            ),
            { startImmediately: true },
          );
          yield* Effect.promise(() => fake.subscribed);
          const subscription = fake.subscriptions[0]!;

          subscription.emit(head(1));
          yield* Deferred.await(cycleStarted);
          // The consumer is suspended mid-cycle while four more distinct heads land.
          for (const version of [2, 3, 4, 5]) {
            subscription.emit(head(version));
          }
          yield* Deferred.succeed(releaseCycle, undefined);

          yield* Fiber.join(running);
          expect(observed).toEqual([head(1), head(5)]);
          expect(subscription.unsubscribed).toBe(1);
        }),
      );
    }),
  );

  it.effect("unsubscribes when the subscriber is interrupted", () =>
    Effect.gen(function* () {
      const fake = makeFakeConvexClient();
      yield* withTransport(fake, (transport) =>
        Effect.gen(function* () {
          const running = yield* Effect.forkChild(
            Stream.runDrain(transport.latestVersion({ companyId: COMPANY_ID })),
            { startImmediately: true },
          );
          yield* Effect.promise(() => fake.subscribed);
          const subscription = fake.subscriptions[0]!;
          subscription.emit(head(1));
          yield* Fiber.interrupt(running);
          expect(subscription.unsubscribed).toBe(1);
        }),
      );
    }),
  );

  it.effect("fails the subscription stream with the mapped reason", () =>
    Effect.gen(function* () {
      const fake = makeFakeConvexClient();
      yield* withTransport(fake, (transport) =>
        Effect.gen(function* () {
          const collected = yield* Effect.forkChild(
            Stream.runCollect(transport.latestVersion({ companyId: COMPANY_ID })).pipe(Effect.flip),
            { startImmediately: true },
          );
          yield* Effect.promise(() => fake.subscribed);
          const subscription = fake.subscriptions[0]!;
          subscription.fail(new TypeError("Failed to fetch"));
          const error = yield* Fiber.join(collected);
          expect(error.reason).toBe("offline");
          expect(subscription.unsubscribed).toBe(1);
        }),
      );
    }),
  );

  it.effect("provides the transport as a layer", () =>
    Effect.gen(function* () {
      const fake = makeFakeConvexClient(() => head(2));
      const program = SyncTransport.pipe(
        Effect.flatMap((transport) =>
          transport.listChanges({ companyId: COMPANY_ID, cursor: CompanyVersion.make(0) }),
        ),
      );
      yield* program.pipe(
        Effect.provide(
          convexSyncTransportLayer({
            convexUrl: "https://example.convex.cloud",
            fetchToken: () => Promise.resolve(null),
            client: fake.client,
          }),
        ),
      );
      expect(fake.calls.map((call) => call.name)).toEqual(["sync:listChanges"]);
    }),
  );
});
