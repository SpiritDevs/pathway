/**
 * Network port for the sync engine, mirroring the five Convex sync endpoints named by
 * `SYNC_FUNCTIONS` (`sync.bootstrap`, `sync.latestVersion`, `sync.listChanges`,
 * `sync.applyOperations`, `sync.reserveIssueKeys`).
 *
 * Every request and response here is the contract shape, unwrapped: a platform adapter passes what
 * Convex validated straight through, so the engine and the backend cannot disagree about a field.
 * The engine never imports a Convex client — the platform (web, Electron, mobile, server) supplies
 * this service, which keeps the engine testable against an in-memory server and keeps Convex out of
 * every surface that only wants the replica.
 *
 * @module sync/transport
 */
import type {
  SyncApplyOperationsRequest,
  SyncApplyOperationsResponse,
  SyncBootstrapRequest,
  SyncBootstrapResponse,
  SyncLatestVersionRequest,
  SyncLatestVersionResponse,
  SyncListChangesRequest,
  SyncListChangesResponse,
  SyncReserveIssueKeysRequest,
  SyncReserveIssueKeysResponse,
} from "@t3tools/contracts/cloudSync";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Stream from "effect/Stream";

/**
 * Everything the transport can fail with. `offline` and `transport` are retryable and leave the
 * replica intact; `unauthorized` and `upgrade-required` are terminal until the app acts on them.
 */
export class SyncTransportError extends Schema.TaggedErrorClass<SyncTransportError>()(
  "SyncTransportError",
  {
    reason: Schema.Literals(["offline", "transport", "unauthorized", "upgrade-required"]),
    message: Schema.String,
  },
) {}

export class SyncTransport extends Context.Service<
  SyncTransport,
  {
    readonly bootstrap: (
      input: SyncBootstrapRequest,
    ) => Effect.Effect<SyncBootstrapResponse, SyncTransportError>;
    /**
     * The one subscription a client holds. Deliberately tiny: subscribing to the pages themselves
     * would push a company's history at every idle client on every edit.
     */
    readonly latestVersion: (
      input: SyncLatestVersionRequest,
    ) => Stream.Stream<SyncLatestVersionResponse, SyncTransportError>;
    readonly listChanges: (
      input: SyncListChangesRequest,
    ) => Effect.Effect<SyncListChangesResponse, SyncTransportError>;
    readonly applyOperations: (
      input: SyncApplyOperationsRequest,
    ) => Effect.Effect<SyncApplyOperationsResponse, SyncTransportError>;
    /**
     * Issue-domain endpoint. The engine never calls it; the issue domain leases blocks through it
     * when that phase lands, and it lives here so one service covers the whole Convex surface.
     */
    readonly reserveIssueKeys: (
      input: SyncReserveIssueKeysRequest,
    ) => Effect.Effect<SyncReserveIssueKeysResponse, SyncTransportError>;
  }
>()("@t3tools/client-runtime/sync/transport/SyncTransport") {}
