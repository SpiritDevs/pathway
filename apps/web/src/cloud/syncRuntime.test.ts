import { describe, expect, it } from "@effect/vitest";
import { setManagedRelaySession, type ManagedRelaySession } from "@spiritdevs/client-runtime/relay";
import {
  makeInProcessWebLockManager,
  makeMemorySyncStore,
  makeWebLeaderElection,
  SyncStore,
  SyncTransport,
  SyncTransportError,
} from "@spiritdevs/client-runtime/sync";
import { SyncClientId } from "@spiritdevs/contracts/cloudSync";
import { CompanyId } from "@spiritdevs/contracts/company";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  cloudSyncClientIdStorageKey,
  cloudSyncScope,
  decodeCloudSyncCompanies,
  readCloudSyncClientId,
  reconcileCloudSyncEngines,
  runCloudSyncEngines,
  useCloudSyncScope,
  type CloudSyncClientIdStorage,
  type CloudSyncCompany,
  type CloudSyncConnection,
} from "./syncRuntime";

const COMPANY_A = CompanyId.make("company-a");
const COMPANY_B = CompanyId.make("company-b");

const company = (companyId: CompanyId, membershipId: string): CloudSyncCompany =>
  decodeCloudSyncCompanies([{ id: companyId, membershipId }])[0]!;

const session = (accountId: string): ManagedRelaySession => ({
  accountId,
  readClerkToken: () => Effect.succeed(null),
});

const makeMemoryStorage = (initial: Record<string, string> = {}): CloudSyncClientIdStorage => {
  const entries = new Map(Object.entries(initial));
  return {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
  };
};

describe("cloudSyncScope", () => {
  it("is the account id of the active session, and nothing without one", () => {
    expect(cloudSyncScope(session("user_123"))).toBe("user_123");
    expect(cloudSyncScope(null)).toBeNull();
    expect(cloudSyncScope(session("   "))).toBeNull();
  });
});

describe("useCloudSyncScope", () => {
  const Probe = () => createElement("span", null, useCloudSyncScope() ?? "none");

  /**
   * The session is written into the app's own registry by `ManagedRelayAuthProvider`, and the
   * runtime mounts above `AppAtomRegistryProvider` — outside any `RegistryContext.Provider`. A
   * reader that took its registry from React context would therefore read the library's private
   * default registry, which nothing ever writes to, and would see "signed out" forever: sync would
   * never start, silently. Rendering with no provider above the probe is exactly that situation.
   */
  it("reads the session from the registry the app writes to, not from React context", () => {
    setManagedRelaySession(appAtomRegistry, {
      accountId: "user_123",
      readClerkToken: () => Promise.resolve(null),
    });
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>user_123</span>");

    setManagedRelaySession(appAtomRegistry, null);
    expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>none</span>");
  });
});

describe("readCloudSyncClientId", () => {
  it("keeps the persisted id under the cloud-sync namespace, per scope", () => {
    const storage = makeMemoryStorage();
    const first = readCloudSyncClientId({
      scope: "user_123",
      storage,
      generateId: () => "client-1",
    });
    const again = readCloudSyncClientId({
      scope: "user_123",
      storage,
      generateId: () => "client-2",
    });
    const otherAccount = readCloudSyncClientId({
      scope: "user_456",
      storage,
      generateId: () => "client-3",
    });

    expect(first).toBe("client-1");
    // A reload must not rename the installation: the outbox's local sequence is scoped by it.
    expect(again).toBe("client-1");
    expect(otherAccount).toBe("client-3");
    expect(storage.getItem(cloudSyncClientIdStorageKey("user_123"))).toBe("client-1");
    expect(cloudSyncClientIdStorageKey("user_123")).toBe("pathway:cloud-sync/user_123/client-id");
  });

  it("ignores a blank stored value", () => {
    const storage = makeMemoryStorage({
      [cloudSyncClientIdStorageKey("user_123")]: "   ",
    });

    expect(
      readCloudSyncClientId({ scope: "user_123", storage, generateId: () => "client-1" }),
    ).toBe("client-1");
  });

  it("still yields an id when storage is unavailable or throws", () => {
    const throwing: CloudSyncClientIdStorage = {
      getItem: () => {
        throw new Error("storage disabled");
      },
      setItem: () => {
        throw new Error("storage disabled");
      },
    };

    expect(
      readCloudSyncClientId({ scope: "user_123", storage: throwing, generateId: () => "a" }),
    ).toBe("a");
    expect(readCloudSyncClientId({ scope: "user_123", storage: null, generateId: () => "b" })).toBe(
      "b",
    );
  });
});

describe("decodeCloudSyncCompanies", () => {
  it("maps each membership to a company and its member actor", () => {
    const companies = decodeCloudSyncCompanies([
      { id: "company-a", membershipId: "membership-a", name: "A", isOwner: true },
      { id: "company-b", membershipId: "membership-b", name: "B", isOwner: false },
    ]);

    expect(companies).toEqual([
      { companyId: "company-a", actor: { kind: "member", membershipId: "membership-a" } },
      { companyId: "company-b", actor: { kind: "member", membershipId: "membership-b" } },
    ]);
  });

  it("drops rows it cannot attribute and collapses duplicates", () => {
    const companies = decodeCloudSyncCompanies([
      { id: "company-a", membershipId: "membership-a" },
      { id: "company-a", membershipId: "membership-duplicate" },
      { id: "company-c" },
      { membershipId: "membership-d" },
      { id: "  ", membershipId: "membership-e" },
      "not-a-row",
    ]);

    expect(companies.map((entry) => entry.companyId)).toEqual(["company-a"]);
  });

  it("answers with nothing for a non-array result", () => {
    expect(decodeCloudSyncCompanies(null)).toEqual([]);
    expect(decodeCloudSyncCompanies({ companies: [] })).toEqual([]);
  });
});

describe("reconcileCloudSyncEngines", () => {
  const running = (...companies: ReadonlyArray<CloudSyncCompany>) =>
    new Map(companies.map((entry) => [entry.companyId, entry] as const));

  it("starts the new companies and leaves the running ones alone", () => {
    const a = company(COMPANY_A, "membership-a");
    const b = company(COMPANY_B, "membership-b");

    expect(reconcileCloudSyncEngines(running(a), [a, b])).toEqual({ start: [b], stop: [] });
  });

  it("stops a company the listing no longer carries", () => {
    const a = company(COMPANY_A, "membership-a");
    const b = company(COMPANY_B, "membership-b");

    expect(reconcileCloudSyncEngines(running(a, b), [a])).toEqual({ start: [], stop: [COMPANY_B] });
  });

  it("restarts a company whose membership was replaced", () => {
    const before = company(COMPANY_A, "membership-a");
    const after = company(COMPANY_A, "membership-a2");

    expect(reconcileCloudSyncEngines(running(before), [after])).toEqual({
      start: [after],
      stop: [COMPANY_A],
    });
  });

  it("stops everything when the listing empties", () => {
    const a = company(COMPANY_A, "membership-a");

    expect(reconcileCloudSyncEngines(running(a), [])).toEqual({ start: [], stop: [COMPANY_A] });
  });
});

// ---------------------------------------------------------------------------
// The supervisor, over fakes
// ---------------------------------------------------------------------------

interface FeedEvent {
  readonly kind: "subscribed" | "unsubscribed";
  readonly companyId: CompanyId;
}

const unusedEndpoint = (name: string) =>
  Effect.fail(
    new SyncTransportError({ reason: "transport", message: `${name} is not used here.` }),
  );

/**
 * A transport whose only real behaviour is the change-feed subscription: an engine that is running
 * holds one, and an engine that has been stopped has let it go, so these events are exactly the
 * observable "is this company's engine alive" signal.
 */
const makeFeedTransport = Effect.fn("makeFeedTransport")(function* () {
  const events = yield* Queue.unbounded<FeedEvent>();
  const transport = SyncTransport.of({
    bootstrap: () => unusedEndpoint("bootstrap"),
    listChanges: () => unusedEndpoint("listChanges"),
    applyOperations: () => unusedEndpoint("applyOperations"),
    reserveIssueKeys: () => unusedEndpoint("reserveIssueKeys"),
    latestVersion: ({ companyId }) =>
      Stream.callback<never, SyncTransportError>(() =>
        Effect.gen(function* () {
          yield* Queue.offer(events, { kind: "subscribed", companyId });
          yield* Effect.addFinalizer(() =>
            Queue.offer(events, { kind: "unsubscribed", companyId }).pipe(Effect.asVoid),
          );
        }),
      ),
  });
  return { events, transport };
});

/** The `connect` seam over a ready-made transport and listing queue. */
const connectionTo = (
  transport: SyncTransport["Service"],
  listings: Queue.Dequeue<ReadonlyArray<CloudSyncCompany>>,
): CloudSyncConnection => ({ transport, companies: Stream.fromQueue(listings) });

describe("runCloudSyncEngines", () => {
  it.effect("runs one engine per company and follows the membership listing", () =>
    Effect.gen(function* () {
      const { events, transport } = yield* makeFeedTransport();
      const store = yield* makeMemorySyncStore();
      const election = yield* makeWebLeaderElection({
        scope: "user_123",
        locks: makeInProcessWebLockManager(),
      });
      const listings = yield* Queue.unbounded<ReadonlyArray<CloudSyncCompany>>();

      const supervisor = yield* Effect.forkChild(
        runCloudSyncEngines({
          clientId: SyncClientId.make("client-1"),
          election,
          connect: Effect.succeed(connectionTo(transport, listings)),
        }).pipe(Effect.provideService(SyncStore, store.service)),
        { startImmediately: true },
      );

      yield* Queue.offer(listings, [company(COMPANY_A, "membership-a")]);
      expect(yield* Queue.take(events)).toEqual({ kind: "subscribed", companyId: COMPANY_A });

      // Joining a second company starts a second engine without disturbing the first.
      yield* Queue.offer(listings, [
        company(COMPANY_A, "membership-a"),
        company(COMPANY_B, "membership-b"),
      ]);
      expect(yield* Queue.take(events)).toEqual({ kind: "subscribed", companyId: COMPANY_B });

      // Leaving one stops exactly its engine.
      yield* Queue.offer(listings, [company(COMPANY_B, "membership-b")]);
      expect(yield* Queue.take(events)).toEqual({ kind: "unsubscribed", companyId: COMPANY_A });

      // Closing the runtime's scope stops what is left.
      yield* Fiber.interrupt(supervisor);
      expect(yield* Queue.take(events)).toEqual({ kind: "unsubscribed", companyId: COMPANY_B });
    }),
  );

  it.effect("runs no engine at all in a follower tab", () =>
    Effect.gen(function* () {
      const { events, transport } = yield* makeFeedTransport();
      const store = yield* makeMemorySyncStore();
      const locks = makeInProcessWebLockManager();
      const thisTab = yield* makeWebLeaderElection({ scope: "user_123", locks });
      const otherTab = yield* makeWebLeaderElection({ scope: "user_123", locks });
      const listings = yield* Queue.unbounded<ReadonlyArray<CloudSyncCompany>>();

      yield* otherTab.acquire;
      const supervisor = yield* Effect.forkChild(
        runCloudSyncEngines({
          clientId: SyncClientId.make("client-1"),
          election: thisTab,
          connect: Effect.succeed(connectionTo(transport, listings)),
        }).pipe(Effect.provideService(SyncStore, store.service)),
        { startImmediately: true },
      );
      yield* Queue.offer(listings, [company(COMPANY_A, "membership-a")]);

      // The listing is already there, so anything this tab was going to do it would have done by
      // now: it is waiting on the lock, not on work.
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect(yield* Queue.size(events)).toBe(0);

      // Handing the lock over is all it takes for the engine to come up.
      yield* otherTab.release;
      expect(yield* Queue.take(events)).toEqual({ kind: "subscribed", companyId: COMPANY_A });
      yield* Fiber.interrupt(supervisor);
    }),
  );

  /**
   * `new ConvexClient(url)` opens a WebSocket in its constructor and `setAuth` mints a Clerk token
   * straight away, so a connection built outside the leadership body would have every open tab of
   * the account holding an authenticated, subscription-less socket for the life of the tab.
   */
  it.effect("opens no connection until this tab is the one doing the work", () =>
    Effect.gen(function* () {
      const { transport } = yield* makeFeedTransport();
      const store = yield* makeMemorySyncStore();
      const locks = makeInProcessWebLockManager();
      const thisTab = yield* makeWebLeaderElection({ scope: "user_123", locks });
      const otherTab = yield* makeWebLeaderElection({ scope: "user_123", locks });
      const listings = yield* Queue.unbounded<ReadonlyArray<CloudSyncCompany>>();
      const opened = yield* Ref.make(0);
      const released = yield* Ref.make(0);

      const connect = Effect.gen(function* () {
        yield* Ref.update(opened, (count) => count + 1);
        yield* Effect.addFinalizer(() => Ref.update(released, (count) => count + 1));
        return connectionTo(transport, listings);
      });

      yield* otherTab.acquire;
      const supervisor = yield* Effect.forkChild(
        runCloudSyncEngines({
          clientId: SyncClientId.make("client-1"),
          election: thisTab,
          connect,
        }).pipe(Effect.provideService(SyncStore, store.service)),
        { startImmediately: true },
      );

      // A follower tab has nothing for a socket to do, and it may never become the leader at all.
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect(yield* Ref.get(opened)).toBe(0);

      yield* otherTab.release;
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect(yield* Ref.get(opened)).toBe(1);

      // Leadership and the connection end together, so a tab that loses the lock stops paying for
      // a socket it can no longer use.
      yield* Fiber.interrupt(supervisor);
      expect(yield* Ref.get(released)).toBe(1);
    }),
  );
});

// ---------------------------------------------------------------------------
// Restarting an engine, and knowing when not to
// ---------------------------------------------------------------------------

/**
 * A transport whose change feed always fails the same way, counting how many times an engine
 * subscribed to it. Every other endpoint is unused: the feed fails before a cycle can run.
 */
const makeFailingFeedTransport = (error: SyncTransportError) =>
  Effect.gen(function* () {
    const attempts = yield* Ref.make(0);
    const transport = SyncTransport.of({
      bootstrap: () => unusedEndpoint("bootstrap"),
      listChanges: () => unusedEndpoint("listChanges"),
      applyOperations: () => unusedEndpoint("applyOperations"),
      reserveIssueKeys: () => unusedEndpoint("reserveIssueKeys"),
      latestVersion: () =>
        Stream.fromEffect(Ref.update(attempts, (count) => count + 1)).pipe(
          Stream.flatMap(() => Stream.fail(error)),
        ),
    });
    return { attempts, transport };
  });

describe("runCloudSyncEngines restart policy", () => {
  const restartDelay = Duration.seconds(5);

  const runUntilQuiet = (error: SyncTransportError) =>
    Effect.gen(function* () {
      const { attempts, transport } = yield* makeFailingFeedTransport(error);
      const store = yield* makeMemorySyncStore();
      const election = yield* makeWebLeaderElection({
        scope: "user_123",
        locks: makeInProcessWebLockManager(),
      });
      const listings = yield* Queue.unbounded<ReadonlyArray<CloudSyncCompany>>();

      const supervisor = yield* Effect.forkChild(
        runCloudSyncEngines({
          clientId: SyncClientId.make("client-1"),
          election,
          connect: Effect.succeed(connectionTo(transport, listings)),
          restartDelay,
        }).pipe(Effect.provideService(SyncStore, store.service)),
        { startImmediately: true },
      );

      yield* Queue.offer(listings, [company(COMPANY_A, "membership-a")]);
      // Well past several restart delays: whatever this policy is going to do, it has done.
      yield* TestClock.adjust(Duration.seconds(60));
      const count = yield* Ref.get(attempts);
      yield* Fiber.interrupt(supervisor);
      return count;
    });

  /**
   * `unauthorized` and `upgrade-required` are verdicts about this token and this build, not weather:
   * the same request would be refused again, so a timer would reproduce the refusal every five
   * seconds for the life of the tab — hammering Convex and hiding the one thing worth reporting.
   */
  it.effect("stops for good when starting the engine again cannot change the answer", () =>
    Effect.gen(function* () {
      expect(
        yield* runUntilQuiet(
          new SyncTransportError({ reason: "unauthorized", message: "not a member" }),
        ),
      ).toBe(1);
      expect(
        yield* runUntilQuiet(
          new SyncTransportError({ reason: "upgrade-required", message: "client too old" }),
        ),
      ).toBe(1);
    }),
  );

  it.effect("keeps restarting while the trouble is a lost connection", () =>
    Effect.gen(function* () {
      expect(
        yield* runUntilQuiet(
          new SyncTransportError({ reason: "transport", message: "socket closed" }),
        ),
      ).toBeGreaterThan(1);
      expect(
        yield* runUntilQuiet(new SyncTransportError({ reason: "offline", message: "no network" })),
      ).toBeGreaterThan(1);
    }),
  );
});
