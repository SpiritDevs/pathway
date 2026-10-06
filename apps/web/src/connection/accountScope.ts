import { managedRelaySessionAtom } from "@spiritdevs/client-runtime/relay";
import * as Effect from "effect/Effect";

import { appAtomRegistry } from "../rpc/atomRegistry";

let connectionAccountScope: string | null = null;

export function readConnectionAccountScope(): string | null {
  return connectionAccountScope;
}

// Connection state lives for the renderer's lifetime. Wait for Clerk's restored
// account before opening its cache; an account change starts a new renderer.
export const awaitConnectionAccountScope = Effect.fn("web.connection.awaitAccount")(function* () {
  const scope = yield* Effect.callback<string>((resume) => {
    const read = () => {
      const accountId = appAtomRegistry.get(managedRelaySessionAtom)?.accountId.trim();
      if (accountId) resume(Effect.succeed(accountId));
    };
    const unsubscribe = appAtomRegistry.subscribe(managedRelaySessionAtom, read);
    read();
    return Effect.sync(unsubscribe);
  });
  connectionAccountScope = scope;
  return scope;
});

export function connectionCacheDatabaseName(scope: string): string {
  return `pathway:connection-runtime/${encodeURIComponent(scope)}`;
}
