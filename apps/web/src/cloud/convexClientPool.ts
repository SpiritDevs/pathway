import { ConvexClient } from "convex/browser";
import type { ConvexAuthTokenFetcher } from "./syncTransport";

export interface CloudClientScope {
  readonly url: string;
  readonly accountId: string;
  readonly sessionId: string;
}

/** Each lease owns its token source; the socket lives until its final consumer leaves. */
export function createConvexClientPool<Client extends Pick<ConvexClient, "setAuth" | "close">>(
  createClient: (url: string) => Client,
) {
  const entries = new Map<string, { client: Client; tokens: Set<ConvexAuthTokenFetcher> }>();
  return (scope: CloudClientScope, fetchToken: ConvexAuthTokenFetcher) => {
    const key = JSON.stringify([scope.url, scope.accountId, scope.sessionId]);
    const tokenSource: ConvexAuthTokenFetcher = (args) => fetchToken(args);
    let entry = entries.get(key);
    if (!entry) {
      const tokens = new Set([tokenSource]);
      const client = createClient(scope.url);
      entry = { client, tokens };
      entries.set(key, entry);
      client.setAuth((options) => tokens.values().next().value?.(options) ?? Promise.resolve(null));
    } else {
      entry.tokens.add(tokenSource);
    }
    const retained = entry;
    let released = false;
    return {
      client: retained.client,
      release() {
        if (released) return;
        released = true;
        retained.tokens.delete(tokenSource);
        if (retained.tokens.size === 0) {
          entries.delete(key);
          void retained.client.close();
        }
      },
    };
  };
}

export const acquireConvexClient = createConvexClientPool((url) => new ConvexClient(url));
