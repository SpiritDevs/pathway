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
 * A fetcher over Clerk's `getToken`, minting from the `convex` template Convex's auth config
 * expects. This is the correct source for the Convex socket; a host that has the Clerk session in
 * hand (the `useAuth().getToken` from `ManagedRelayAuthProvider`) should pass this one.
 */
export const makeClerkConvexTokenFetcher =
  (
    getToken: (options: {
      readonly template: string;
      readonly skipCache: boolean;
    }) => Promise<string | null>,
  ): ConvexAuthTokenFetcher =>
  ({ forceRefreshToken }) =>
    getToken(resolveConvexClerkTokenOptions({ forceRefreshToken }));

/**
 * Fallback fetcher over the module-level relay token accessor, for a host that has no Clerk hook
 * at hand. It returns the *relay* token: minted from `VITE_CLERK_JWT_TEMPLATE`, so its `aud` is the
 * relay's application id, not `convex`. A deployment whose relay template is not also registered
 * with Convex will see this token refused — prefer {@link makeClerkConvexTokenFetcher}.
 */
export const managedRelayClerkTokenFetcher: ConvexAuthTokenFetcher = () =>
  readManagedRelayClerkToken();
