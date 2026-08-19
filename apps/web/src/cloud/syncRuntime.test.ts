import { describe, expect, it } from "@effect/vitest";
import type { CompanyRegistryReplicaState } from "@spiritdevs/client-runtime/connection";
import { setManagedRelaySession, type ManagedRelaySession } from "@spiritdevs/client-runtime/relay";
import {
  EMPTY_STORED_SYNC_STATE,
  type EnvironmentRegistrationEntity,
  makeInProcessWebLockManager,
  makeMemorySyncStore,
  makeWebLeaderElection,
  SYNC_BOOTSTRAP_GENERATION,
  SYNC_DOCUMENT_SCHEMA_VERSION,
  SyncStore,
  SyncTransport,
  SyncTransportError,
} from "@spiritdevs/client-runtime/sync";
import { EnvironmentId } from "@spiritdevs/contracts";
import {
  AuthorizationEpoch,
  CompanyVersion,
  LocalSequence,
  SYNC_PROTOCOL_VERSION,
  SyncClientId,
  SyncEntityId,
  SyncOperationId,
  type SyncOperationEnvelope,
} from "@spiritdevs/contracts/cloudSync";
import { EnvironmentRegistrationId } from "@spiritdevs/contracts/cloudProject";
import { CompanyId, MembershipId, RoleId } from "@spiritdevs/contracts/company";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { Atom } from "effect/unstable/reactivity";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  automaticEnvironmentRegistrationServiceRoleId,
  environmentRegistrationMatchesInfo,
  registerEnvironmentAutomatically,
} from "./environmentRegistration";
import {
  cloudSyncClientIdStorageKey,
  cloudSyncScope,
  classifyCloudSyncConnectionError,
  decodeCloudSyncCompanies,
  discoverCompanyEnvironmentConnections,
  repairCloudSyncCurrentUserWorkspace,
  readCloudSyncClientId,
  reconcileCloudSyncEngines,
  runCloudSyncEngines,
  mountCloudSyncRuntimeAtom,
  shouldRunCloudSyncRuntime,
  useCloudSyncScope,
  type CloudSyncClientIdStorage,
  type CloudSyncCompany,
  type CloudSyncCompanyListing,
  type CloudSyncConnection,
} from "./syncRuntime";

const COMPANY_A = CompanyId.make("company-a");
const COMPANY_B = CompanyId.make("company-b");
const OWN_ENVIRONMENT_ID = EnvironmentId.make("environment-own");
const REMOTE_ENVIRONMENT_ID = EnvironmentId.make("environment-remote");

const company = (companyId: CompanyId, membershipId: string): CloudSyncCompany =>
  decodeCloudSyncCompanies([{ id: companyId, membershipId }]).companies[0]!;

const cleanListing = (...companies: ReadonlyArray<CloudSyncCompany>): CloudSyncCompanyListing => ({
  companies,
  decodedCleanly: true,
  droppedRows: 0,
});

const partialListing = (value: unknown): CloudSyncCompanyListing => decodeCloudSyncCompanies(value);

const pendingEnvelope = (companyId: CompanyId): SyncOperationEnvelope => ({
  protocolVersion: SYNC_PROTOCOL_VERSION,
  operationId: SyncOperationId.make(`op-${companyId}`),
  companyId,
  clientId: SyncClientId.make("client-1"),
  environmentId: null,
  actor: { kind: "member", membershipId: MembershipId.make("membership-a") },
  localSequence: LocalSequence.make(1),
  baseVersion: CompanyVersion.make(0),
  entityId: SyncEntityId.make(`issue-${companyId}`),
  dependsOn: [],
  kind: "issue.create",
  args: { title: "offline draft" },
});

const captureLogs = () => {
  const entries: Array<{ readonly level: string; readonly message: string }> = [];
  const describe = (value: unknown): string => {
    if (typeof value !== "object" || value === null) return String(value);
    return Object.values(value).map(describe).join(" ");
  };
  const logger = Logger.make<unknown, void>((options) => {
    const parts = Array.isArray(options.message) ? options.message : [options.message];
    entries.push({ level: String(options.logLevel), message: parts.map(describe).join(" ") });
  });
  return { entries, layer: Logger.layer([logger], { mergeWithExisting: false }) };
};

const session = (accountId: string): ManagedRelaySession => ({
  accountId,
  readClerkToken: () => Effect.succeed(null),
});

const environmentRegistration = (environmentId: EnvironmentId): EnvironmentRegistrationEntity => ({
  entityKind: "environmentRegistration",
  id: EnvironmentRegistrationId.make(`registration-${environmentId}`),
  environmentId,
  publicKeyThumbprint: "thumbprint",
  descriptor: {
    environmentId,
    label: environmentId === OWN_ENVIRONMENT_ID ? "This Mac" : "Build server",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "2026.8.0",
    capabilities: { repositoryIdentity: true },
  },
  relayLinkState: "linked",
  managedEndpointAvailable: true,
  lastSeenAt: 1_000,
  serviceRoleIds: [],
  teamIds: [],
  state: "active",
  registeredByMembershipId: null,
  createdAt: 1_000,
  updatedAt: 2_000,
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

describe("classifyCloudSyncConnectionError", () => {
  it("retries only an authentication refusal caused by Clerk returning no token", () => {
    const unauthorized = new SyncTransportError({
      reason: "unauthorized",
      message: "not-authenticated",
    });

    expect(classifyCloudSyncConnectionError(unauthorized, false)).toMatchObject({
      reason: "transport",
    });
    expect(classifyCloudSyncConnectionError(unauthorized, true)).toBe(unauthorized);
    expect(classifyCloudSyncConnectionError(unauthorized, null)).toBe(unauthorized);

    const offline = new SyncTransportError({ reason: "offline", message: "no network" });
    expect(classifyCloudSyncConnectionError(offline, false)).toBe(offline);
  });
});

describe("shouldRunCloudSyncRuntime", () => {
  it("starts discovery for every signed-in account, including one still completing onboarding", () => {
    expect(shouldRunCloudSyncRuntime(true)).toBe(true);
    expect(shouldRunCloudSyncRuntime(false)).toBe(false);
    expect(shouldRunCloudSyncRuntime(undefined)).toBe(false);
  });
});

describe("mountCloudSyncRuntimeAtom", () => {
  it("evaluates the lazy atom when the effect-phase subscription mounts", () => {
    let evaluations = 0;
    const atom = Atom.make(() => {
      evaluations += 1;
      return undefined;
    });

    const unmount = mountCloudSyncRuntimeAtom(atom);
    expect(evaluations).toBe(1);
    unmount();
  });
});

describe("discoverCompanyEnvironmentConnections", () => {
  it("never presents the current environment as a remote connection", () => {
    const replica = {
      view: new Map([
        ["own", environmentRegistration(OWN_ENVIRONMENT_ID)],
        ["remote", environmentRegistration(REMOTE_ENVIRONMENT_ID)],
      ]),
    } satisfies CompanyRegistryReplicaState;

    expect(
      discoverCompanyEnvironmentConnections(new Map([[COMPANY_A, replica]]), OWN_ENVIRONMENT_ID),
    ).toEqual(new Map([[REMOTE_ENVIRONMENT_ID, "Build server"]]));
  });
});

describe("automaticEnvironmentRegistrationServiceRoleId", () => {
  const role = (id: string, permissions: ReadonlyArray<string>) => ({
    entityKind: "role" as const,
    id: RoleId.make(id),
    name: id,
    description: "",
    permissions,
    seeded: false,
    createdAt: 1_000,
    updatedAt: 1_000,
  });
  const requiredPermissions = [
    "company.read",
    "projects.read",
    "issues.read",
    "workflow.manage",
    "environments.read",
  ];

  it("does nothing when this environment already has an active registration", () => {
    expect(
      automaticEnvironmentRegistrationServiceRoleId(
        [role("service", requiredPermissions), environmentRegistration(OWN_ENVIRONMENT_ID)],
        OWN_ENVIRONMENT_ID,
      ),
    ).toBeNull();
  });

  it("selects the least-privileged suitable service role for a new environment", () => {
    expect(
      automaticEnvironmentRegistrationServiceRoleId(
        [
          role("insufficient", requiredPermissions.slice(0, -1)),
          role("broad", [...requiredPermissions, "environments.manage"]),
          role("service", requiredPermissions),
        ],
        OWN_ENVIRONMENT_ID,
      ),
    ).toBe("service");
  });

  it("reactivates a revoked registration", () => {
    expect(
      automaticEnvironmentRegistrationServiceRoleId(
        [
          role("service", requiredPermissions),
          { ...environmentRegistration(OWN_ENVIRONMENT_ID), state: "revoked" as const },
        ],
        OWN_ENVIRONMENT_ID,
      ),
    ).toBe("service");
  });

  it("registers a new primary environment as soon as its company replica is ready", async () => {
    const registrations: unknown[] = [];
    const info = {
      descriptor: environmentRegistration(OWN_ENVIRONMENT_ID).descriptor,
      publicKeyThumbprint: "thumbprint",
      relayLinkState: "unlinked" as const,
      managedEndpointAvailable: false,
    };
    const registered = await registerEnvironmentAutomatically({
      companyId: COMPANY_A,
      environmentId: OWN_ENVIRONMENT_ID,
      replica: {
        view: new Map([["role:service", role("service", requiredPermissions)]]),
      },
      control: {
        registerEnvironment: async (args) => {
          registrations.push(args);
        },
      },
      readRegistrationInfo: async () => info,
    });

    expect(registered).toBe(true);
    expect(registrations).toEqual([
      { companyId: COMPANY_A, info, serviceRoleIds: [RoleId.make("service")] },
    ]);
  });

  it("does not republish an unchanged active environment", async () => {
    const registration = environmentRegistration(OWN_ENVIRONMENT_ID);
    const info = {
      descriptor: registration.descriptor,
      publicKeyThumbprint: registration.publicKeyThumbprint,
      relayLinkState: registration.relayLinkState,
      managedEndpointAvailable: registration.managedEndpointAvailable,
    };
    expect(environmentRegistrationMatchesInfo(registration, info)).toBe(true);

    const registrations: unknown[] = [];
    const registered = await registerEnvironmentAutomatically({
      companyId: COMPANY_A,
      environmentId: OWN_ENVIRONMENT_ID,
      replica: { view: new Map([["registration:own", registration]]) },
      control: {
        registerEnvironment: async (args) => {
          registrations.push(args);
        },
      },
      readRegistrationInfo: async () => info,
    });

    expect(registered).toBe(false);
    expect(registrations).toEqual([]);
  });

  it("refreshes an active environment when its version and Pathway Connect state change", async () => {
    const registration = {
      ...environmentRegistration(OWN_ENVIRONMENT_ID),
      descriptor: {
        ...environmentRegistration(OWN_ENVIRONMENT_ID).descriptor,
        serverVersion: "0.0.33",
      },
      relayLinkState: "unlinked" as const,
      managedEndpointAvailable: false,
      serviceRoleIds: [RoleId.make("existing-service")],
    };
    const info = {
      descriptor: { ...registration.descriptor, serverVersion: "0.0.37" },
      publicKeyThumbprint: registration.publicKeyThumbprint,
      relayLinkState: "linked" as const,
      managedEndpointAvailable: true,
    };
    expect(environmentRegistrationMatchesInfo(registration, info)).toBe(false);

    const registrations: unknown[] = [];
    const registered = await registerEnvironmentAutomatically({
      companyId: COMPANY_A,
      environmentId: OWN_ENVIRONMENT_ID,
      replica: { view: new Map([["registration:own", registration]]) },
      control: {
        registerEnvironment: async (args) => {
          registrations.push(args);
        },
      },
      readRegistrationInfo: async () => info,
    });

    expect(registered).toBe(true);
    expect(registrations).toEqual([
      {
        companyId: COMPANY_A,
        info,
        serviceRoleIds: [RoleId.make("existing-service")],
      },
    ]);
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
    const decoded = decodeCloudSyncCompanies([
      { id: "company-a", membershipId: "membership-a", name: "A", isOwner: true },
      { id: "company-b", membershipId: "membership-b", name: "B", isOwner: false },
    ]);

    expect(decoded).toEqual({
      decodedCleanly: true,
      droppedRows: 0,
      companies: [
        { companyId: "company-a", actor: { kind: "member", membershipId: "membership-a" } },
        { companyId: "company-b", actor: { kind: "member", membershipId: "membership-b" } },
      ],
    });
  });

  it("drops rows it cannot attribute and collapses duplicates", () => {
    const decoded = decodeCloudSyncCompanies([
      { id: "company-a", membershipId: "membership-a" },
      { id: "company-a", membershipId: "membership-duplicate" },
      { id: "company-c" },
      { membershipId: "membership-d" },
      { id: "  ", membershipId: "membership-e" },
      "not-a-row",
    ]);

    expect(decoded.companies.map((entry) => entry.companyId)).toEqual(["company-a"]);
    expect(decoded.decodedCleanly).toBe(false);
    expect(decoded.droppedRows).toBe(4);
  });

  it("answers with nothing for a non-array result", () => {
    expect(decodeCloudSyncCompanies(null)).toEqual({
      companies: [],
      decodedCleanly: false,
      droppedRows: 1,
    });
    expect(decodeCloudSyncCompanies({ companies: [] })).toEqual({
      companies: [],
      decodedCleanly: false,
      droppedRows: 1,
    });
  });
});

describe("repairCloudSyncCurrentUserWorkspace", () => {
  it.effect("repairs company bootstrap data before company discovery starts", () => {
    let calls = 0;
    return Effect.gen(function* () {
      const result = yield* repairCloudSyncCurrentUserWorkspace({
        mutation: async (_reference, args) => {
          expect(args).toEqual({});
          calls += 1;
          return { id: "company-a" };
        },
      });

      expect(result).toEqual({ id: "company-a" });
      expect(calls).toBe(1);
    });
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
  listings: Queue.Dequeue<CloudSyncCompanyListing>,
): CloudSyncConnection => ({ transport, companies: Stream.fromQueue(listings) });

describe("runCloudSyncEngines", () => {
  it.effect("publishes compact status and removes it with the company engine scope", () =>
    Effect.gen(function* () {
      const { transport } = yield* makeFeedTransport();
      const store = yield* makeMemorySyncStore();
      const election = yield* makeWebLeaderElection({
        scope: "user_123",
        locks: makeInProcessWebLockManager(),
      });
      const listings = yield* Queue.unbounded<CloudSyncCompanyListing>();
      const published = yield* Queue.unbounded<{
        readonly companyId: CompanyId;
        readonly phase: string | null;
      }>();
      const publishedMemberships = yield* Queue.unbounded<{
        readonly companyId: CompanyId;
        readonly membershipId: MembershipId | null;
      }>();
      const supervisor = yield* Effect.forkChild(
        runCloudSyncEngines({
          clientId: SyncClientId.make("client-1"),
          election,
          connect: Effect.succeed(connectionTo(transport, listings)),
          publishCompanySyncStatus: (companyId, status) =>
            Queue.offer(published, { companyId, phase: status?.phase ?? null }),
          publishCompanyRegistryMembershipId: (companyId, membershipId) =>
            Queue.offer(publishedMemberships, { companyId, membershipId }),
        }).pipe(Effect.provideService(SyncStore, store.service)),
        { startImmediately: true },
      );

      yield* Queue.offer(listings, cleanListing(company(COMPANY_A, "membership-a")));
      expect(yield* Queue.take(publishedMemberships)).toEqual({
        companyId: COMPANY_A,
        membershipId: "membership-a",
      });
      expect(yield* Queue.take(published)).toEqual({
        companyId: COMPANY_A,
        phase: "bootstrapping",
      });

      yield* Queue.offer(listings, cleanListing());
      expect(yield* Queue.take(publishedMemberships)).toEqual({
        companyId: COMPANY_A,
        membershipId: null,
      });
      expect(yield* Queue.take(published)).toEqual({ companyId: COMPANY_A, phase: null });
      yield* Fiber.interrupt(supervisor);
    }),
  );

  it.effect("publishes only live mutation handles across reconciliation and teardown", () =>
    Effect.gen(function* () {
      const { transport } = yield* makeFeedTransport();
      const store = yield* makeMemorySyncStore();
      const election = yield* makeWebLeaderElection({
        scope: "user_123",
        locks: makeInProcessWebLockManager(),
      });
      const listings = yield* Queue.unbounded<CloudSyncCompanyListing>();
      const published = yield* Queue.unbounded<{
        readonly companyId: CompanyId;
        readonly available: boolean;
      }>();
      const supervisor = yield* Effect.forkChild(
        runCloudSyncEngines({
          clientId: SyncClientId.make("client-1"),
          election,
          connect: Effect.succeed(connectionTo(transport, listings)),
          publishCompanySyncEngineHandle: (companyId, handle) =>
            Queue.offer(published, { companyId, available: handle !== null }),
        }).pipe(Effect.provideService(SyncStore, store.service)),
        { startImmediately: true },
      );

      yield* Queue.offer(listings, cleanListing(company(COMPANY_A, "membership-a")));
      expect(yield* Queue.take(published)).toEqual({ companyId: COMPANY_A, available: true });

      // Reconciliation closes the company scope and waits for the engine driver to retract itself.
      yield* Queue.offer(listings, cleanListing());
      expect(yield* Queue.take(published)).toEqual({ companyId: COMPANY_A, available: false });

      yield* Queue.offer(listings, cleanListing(company(COMPANY_A, "membership-a")));
      expect(yield* Queue.take(published)).toEqual({ companyId: COMPANY_A, available: true });

      // Leadership loss/runtime teardown interrupts every remaining company scope through the same
      // path, so no dead handle survives it either.
      yield* Fiber.interrupt(supervisor);
      expect(yield* Queue.take(published)).toEqual({ companyId: COMPANY_A, available: false });
    }),
  );

  it.effect("runs one engine per company and follows the membership listing", () =>
    Effect.gen(function* () {
      const { events, transport } = yield* makeFeedTransport();
      const store = yield* makeMemorySyncStore();
      const election = yield* makeWebLeaderElection({
        scope: "user_123",
        locks: makeInProcessWebLockManager(),
      });
      const listings = yield* Queue.unbounded<CloudSyncCompanyListing>();

      const supervisor = yield* Effect.forkChild(
        runCloudSyncEngines({
          clientId: SyncClientId.make("client-1"),
          election,
          connect: Effect.succeed(connectionTo(transport, listings)),
        }).pipe(Effect.provideService(SyncStore, store.service)),
        { startImmediately: true },
      );

      yield* Queue.offer(listings, cleanListing(company(COMPANY_A, "membership-a")));
      expect(yield* Queue.take(events)).toEqual({ kind: "subscribed", companyId: COMPANY_A });

      // Joining a second company starts a second engine without disturbing the first.
      yield* Queue.offer(
        listings,
        cleanListing(company(COMPANY_A, "membership-a"), company(COMPANY_B, "membership-b")),
      );
      expect(yield* Queue.take(events)).toEqual({ kind: "subscribed", companyId: COMPANY_B });

      // Leaving one stops exactly its engine.
      yield* Queue.offer(listings, cleanListing(company(COMPANY_B, "membership-b")));
      expect(yield* Queue.take(events)).toEqual({ kind: "unsubscribed", companyId: COMPANY_A });

      // Closing the runtime's scope stops what is left.
      yield* Fiber.interrupt(supervisor);
      expect(yield* Queue.take(events)).toEqual({ kind: "unsubscribed", companyId: COMPANY_B });
    }),
  );

  it.effect("purges only an authenticated clean absence and logs the dropped outbox count", () =>
    Effect.gen(function* () {
      const { events, transport } = yield* makeFeedTransport();
      const store = yield* makeMemorySyncStore();
      const election = yield* makeWebLeaderElection({
        scope: "user_123",
        locks: makeInProcessWebLockManager(),
      });
      const listings = yield* Queue.unbounded<CloudSyncCompanyListing>();
      const logs = captureLogs();
      const envelope = pendingEnvelope(COMPANY_A);
      yield* store.service.commit(COMPANY_A, {
        checkpoint: {
          schemaVersion: SYNC_DOCUMENT_SCHEMA_VERSION,
          bootstrapGeneration: SYNC_BOOTSTRAP_GENERATION,
          companyId: COMPANY_A,
          cursor: CompanyVersion.make(1),
          authorizationEpoch: AuthorizationEpoch.make(0),
          bootstrapped: true,
        },
        upsertEntities: [
          {
            entityKind: "issue",
            entityId: SyncEntityId.make("cached-a"),
            version: CompanyVersion.make(1),
            payload: { cached: true },
          },
        ],
        upsertOutbox: [{ envelope, status: { _tag: "Pending" } }],
        localSequenceHighWater: LocalSequence.make(1),
      });
      yield* store.service.commit(COMPANY_B, {
        localSequenceHighWater: LocalSequence.make(2),
      });

      const supervisor = yield* Effect.forkChild(
        runCloudSyncEngines({
          clientId: SyncClientId.make("client-1"),
          election,
          connect: Effect.succeed(connectionTo(transport, listings)),
        }).pipe(Effect.provideService(SyncStore, store.service), Effect.provide(logs.layer)),
        { startImmediately: true },
      );

      // A successful protected listMine answer is the positive signal. Company A is absent while
      // B remains, so A is wiped even though this runtime never started its old engine.
      yield* Queue.offer(listings, cleanListing(company(COMPANY_B, "membership-b")));
      expect(yield* Queue.take(events)).toEqual({ kind: "subscribed", companyId: COMPANY_B });

      expect(yield* store.snapshot(COMPANY_A)).toEqual(EMPTY_STORED_SYNC_STATE);
      expect((yield* store.snapshot(COMPANY_B)).localSequenceHighWater).toBe(2);
      expect(
        logs.entries.some(
          (entry) =>
            entry.level === "Warn" &&
            entry.message.includes("purged after authenticated company removal") &&
            entry.message.includes("1"),
        ),
      ).toBe(true);
      yield* Fiber.interrupt(supervisor);
    }),
  );

  it.effect("retains absent caches when the company listing dropped malformed rows", () =>
    Effect.gen(function* () {
      const { transport } = yield* makeFeedTransport();
      const store = yield* makeMemorySyncStore();
      const election = yield* makeWebLeaderElection({
        scope: "user_123",
        locks: makeInProcessWebLockManager(),
      });
      const listings = yield* Queue.unbounded<CloudSyncCompanyListing>();
      const logs = captureLogs();
      yield* store.service.commit(COMPANY_A, {
        upsertOutbox: [{ envelope: pendingEnvelope(COMPANY_A), status: { _tag: "Pending" } }],
        localSequenceHighWater: LocalSequence.make(1),
      });

      const supervisor = yield* Effect.forkChild(
        runCloudSyncEngines({
          clientId: SyncClientId.make("client-1"),
          election,
          connect: Effect.succeed(connectionTo(transport, listings)),
        }).pipe(Effect.provideService(SyncStore, store.service), Effect.provide(logs.layer)),
        { startImmediately: true },
      );
      yield* Queue.offer(listings, partialListing([{ id: "company-unknown" }]));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;

      expect((yield* store.snapshot(COMPANY_A)).outbox).toHaveLength(1);
      expect(
        logs.entries.some(
          (entry) =>
            entry.level === "Warn" && entry.message.includes("retaining absent local state"),
        ),
      ).toBe(true);
      yield* Fiber.interrupt(supervisor);
    }),
  );

  it.effect("runs no engine at all in a follower tab", () =>
    Effect.gen(function* () {
      const { events, transport } = yield* makeFeedTransport();
      const store = yield* makeMemorySyncStore();
      const locks = makeInProcessWebLockManager();
      const thisTab = yield* makeWebLeaderElection({ scope: "user_123", locks });
      const otherTab = yield* makeWebLeaderElection({ scope: "user_123", locks });
      const listings = yield* Queue.unbounded<CloudSyncCompanyListing>();

      yield* otherTab.acquire;
      const supervisor = yield* Effect.forkChild(
        runCloudSyncEngines({
          clientId: SyncClientId.make("client-1"),
          election: thisTab,
          connect: Effect.succeed(connectionTo(transport, listings)),
        }).pipe(Effect.provideService(SyncStore, store.service)),
        { startImmediately: true },
      );
      yield* Queue.offer(listings, cleanListing(company(COMPANY_A, "membership-a")));

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
      const listings = yield* Queue.unbounded<CloudSyncCompanyListing>();
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
    const attempted = yield* Queue.unbounded<void>();
    const transport = SyncTransport.of({
      bootstrap: () => unusedEndpoint("bootstrap"),
      listChanges: () => unusedEndpoint("listChanges"),
      applyOperations: () => unusedEndpoint("applyOperations"),
      reserveIssueKeys: () => unusedEndpoint("reserveIssueKeys"),
      latestVersion: () =>
        Stream.fromEffect(
          Effect.all([
            Ref.update(attempts, (count) => count + 1),
            Queue.offer(attempted, undefined),
          ]),
        ).pipe(Stream.flatMap(() => Stream.fail(error))),
    });
    return { attempted, attempts, transport };
  });

describe("runCloudSyncEngines restart policy", () => {
  const restartDelay = Duration.seconds(5);

  const runUntilQuiet = (error: SyncTransportError) =>
    Effect.gen(function* () {
      const { attempted, attempts, transport } = yield* makeFailingFeedTransport(error);
      const store = yield* makeMemorySyncStore();
      const election = yield* makeWebLeaderElection({
        scope: "user_123",
        locks: makeInProcessWebLockManager(),
      });
      const listings = yield* Queue.unbounded<CloudSyncCompanyListing>();

      const supervisor = yield* Effect.forkChild(
        runCloudSyncEngines({
          clientId: SyncClientId.make("client-1"),
          election,
          connect: Effect.succeed(connectionTo(transport, listings)),
          restartDelay,
        }).pipe(Effect.provideService(SyncStore, store.service)),
        { startImmediately: true },
      );

      yield* Queue.offer(listings, cleanListing(company(COMPANY_A, "membership-a")));
      yield* Queue.take(attempted);
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

  it.effect("does not purge when an authorized company engine stops as unauthorized", () =>
    Effect.gen(function* () {
      const { attempted, attempts, transport } = yield* makeFailingFeedTransport(
        new SyncTransportError({ reason: "unauthorized", message: "membership changed" }),
      );
      const store = yield* makeMemorySyncStore();
      yield* store.service.commit(COMPANY_A, {
        localSequenceHighWater: LocalSequence.make(1),
      });
      const election = yield* makeWebLeaderElection({
        scope: "user_123",
        locks: makeInProcessWebLockManager(),
      });
      const listings = yield* Queue.unbounded<CloudSyncCompanyListing>();
      const supervisor = yield* Effect.forkChild(
        runCloudSyncEngines({
          clientId: SyncClientId.make("client-1"),
          election,
          connect: Effect.succeed(connectionTo(transport, listings)),
          restartDelay,
        }).pipe(Effect.provideService(SyncStore, store.service)),
        { startImmediately: true },
      );

      yield* Queue.offer(listings, cleanListing(company(COMPANY_A, "membership-a")));
      yield* Queue.take(attempted);
      yield* TestClock.adjust(Duration.seconds(60));
      expect(yield* Ref.get(attempts)).toBe(1);
      expect((yield* store.snapshot(COMPANY_A)).localSequenceHighWater).toBe(1);
      yield* Fiber.interrupt(supervisor);
    }),
  );

  it.effect("does not purge when a null token makes listMine fail unauthenticated", () =>
    Effect.gen(function* () {
      const { transport } = yield* makeFeedTransport();
      const store = yield* makeMemorySyncStore();
      yield* store.service.commit(COMPANY_A, {
        localSequenceHighWater: LocalSequence.make(1),
      });
      const election = yield* makeWebLeaderElection({
        scope: "user_123",
        locks: makeInProcessWebLockManager(),
      });
      const notAuthenticated = new SyncTransportError({
        reason: "unauthorized",
        message: "not-authenticated",
      });
      const supervisor = yield* Effect.forkChild(
        runCloudSyncEngines({
          clientId: SyncClientId.make("client-1"),
          election,
          connect: Effect.succeed({
            transport,
            companies: Stream.fail(notAuthenticated),
          }),
        }).pipe(Effect.provideService(SyncStore, store.service)),
        { startImmediately: true },
      );

      yield* Fiber.await(supervisor);
      expect((yield* store.snapshot(COMPANY_A)).localSequenceHighWater).toBe(1);
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
