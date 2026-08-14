/**
 * Cloud sync engine: a framework-neutral local replica, durable outbox, and change-feed driver.
 *
 * Nothing here runs until a platform provides {@link module:sync/capability} enabled plus a
 * {@link module:sync/transport} and a {@link module:sync/persistence} adapter, so a build that
 * imports this module still behaves exactly as it did before.
 *
 * @module sync
 */
export * from "./adapter.ts";
export * from "./capability.ts";
export * from "./codec.ts";
export * from "./document.ts";
export * from "./engine.ts";
export * from "./memoryStore.ts";
export * from "./model.ts";
export * from "./orderKey.ts";
export * from "./outbox.ts";
export * from "./persistence.ts";
export * from "./presentation.ts";
export * from "./replica.ts";
export * from "./transport.ts";
