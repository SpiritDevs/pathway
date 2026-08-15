/**
 * Cloud sync engine: a framework-neutral local replica, durable outbox, and change-feed driver.
 *
 * Nothing here runs until a platform provides {@link module:sync/capability} enabled plus a
 * {@link module:sync/transport} and a {@link module:sync/persistence} adapter, so a build that
 * imports this module still behaves exactly as it did before.
 *
 * @module sync
 */
// `indexedDbStore.ts` is deliberately NOT re-exported here: it names ambient DOM types
// (`IDBDatabase`, `IDBFactory`), which would break every consumer compiled without the DOM lib
// (e.g. `apps/server`). Browser platforms import it via `@spiritdevs/client-runtime/sync/indexeddb`.
export * from "./adapter.ts";
export * from "./capability.ts";
export * from "./codec.ts";
export * from "./companyDomain.ts";
export * from "./document.ts";
export * from "./engine.ts";
export * from "./issueDomain.ts";
export * from "./issueOperationsFromRpc.ts";
export * from "./issueReadModel.ts";
export * from "./memoryStore.ts";
export * from "./model.ts";
export * from "./orderKey.ts";
export * from "./outbox.ts";
export * from "./persistence.ts";
export * from "./presentation.ts";
export * from "./replica.ts";
export * from "./sqliteStore.ts";
export * from "./transport.ts";
export * from "./webLeader.ts";
export * from "./webNamespace.ts";
