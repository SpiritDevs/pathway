/**
 * Token sources for the browser Convex transport.
 *
 * This lives beside `syncTransport.ts` rather than inside it so the transport stays pure: reaching
 * the signed-in Clerk session means importing `managedAuth.tsx`, which pulls in React, Clerk, and
 * the module runtime. The transport takes a fetcher; this module supplies the app's.
 *
 * @module cloud/syncTransportAuth
 */
import { readManagedRelayClerkToken } from "./managedAuth";
import { resolveConvexClerkTokenOptions } from "./publicConfig";
import type { ConvexAuthTokenFetcher } from "./syncTransport";

/**
 * Answers `null` for a token source that rejected.
 *
 * Convex's contract for the fetcher is `Promise<string | null | undefined>`, and it has no handling
 * for a rejection: `AuthenticationManager.setConfig` pauses the socket, awaits the fetcher, and
 * resumes it only on the line after the await, so a rejection leaves the socket paused for good —
 * queries never settle, `onUpdate` never fires, not even its `onError`. The engine then hangs with
 * nothing to catch and no phase to report. Clerk really does reject rather than resolve `null`:
 * `Session.getToken` throws `ClerkOfflineError` when the tab is offline, and the API error straight
 * through when the `convex` JWT template is missing.
 *
 * `null` is the answer that keeps the machinery honest — Convex resumes an unauthenticated socket,
 * the deployment refuses with `not-authenticated`, and that refusal is a `SyncTransportError` the
 * engine can record and the runtime can act on.
 */
function tokenOrNull(read: () => Promise<string | null>): Promise<string | null> {
  return read().catch((error: unknown) => {
    console.warn("Cloud sync could not mint a Clerk token; continuing unauthenticated.", error);
    return null;
  });
}

/**
 * A fetcher over Clerk's `getToken`, minting from the `convex` template Convex's auth config
 * expects. This is the correct source for the Convex socket; a host that has the Clerk session in
 * hand (the `useAuth().getToken` from `ManagedRelayAuthProvider`) should pass this one.
 *
 * Total by construction — see {@link tokenOrNull}.
 */
export const makeClerkConvexTokenFetcher =
  (
    getToken: (options: {
      readonly template: string;
      readonly skipCache: boolean;
    }) => Promise<string | null>,
  ): ConvexAuthTokenFetcher =>
  ({ forceRefreshToken }) =>
    tokenOrNull(() => getToken(resolveConvexClerkTokenOptions({ forceRefreshToken })));

/**
 * Fallback fetcher over the module-level relay token accessor, for a host that has no Clerk hook
 * at hand. It returns the *relay* token: minted from `VITE_CLERK_JWT_TEMPLATE`, so its `aud` is the
 * relay's application id, not `convex`. A deployment whose relay template is not also registered
 * with Convex will see this token refused — prefer {@link makeClerkConvexTokenFetcher}.
 *
 * Total by construction — see {@link tokenOrNull}. This path throws for a second reason: it reads
 * the relay template out of the public config, which raises when the deployment never set one.
 */
export const managedRelayClerkTokenFetcher: ConvexAuthTokenFetcher = () =>
  tokenOrNull(() => readManagedRelayClerkToken());
