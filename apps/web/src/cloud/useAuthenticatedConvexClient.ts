import { useAuth } from "@clerk/react";
import { useEffect, useRef, useState } from "react";
import { acquireConvexClient } from "./convexClientPool";
import { resolveCloudSyncConvexUrl } from "./publicConfig";
import { makeClerkConvexTokenFetcher } from "./syncTransportAuth";

/** Shared feature connection, fenced synchronously when its account or session changes. */
export function useAuthenticatedConvexClient() {
  const { getToken, isSignedIn, userId, sessionId } = useAuth({ treatPendingAsSignedOut: false });
  const url = resolveCloudSyncConvexUrl();
  const key =
    isSignedIn && userId && sessionId && url ? JSON.stringify([url, userId, sessionId]) : null;
  const getTokenRef = useRef({ getToken, key });
  getTokenRef.current = { getToken, key };
  const [connection, setConnection] = useState<{
    key: string;
    lease: ReturnType<typeof acquireConvexClient>;
  } | null>(null);
  useEffect(() => {
    if (!key || !url || !userId || !sessionId) {
      setConnection(null);
      return;
    }
    const lease = acquireConvexClient(
      { url, accountId: userId, sessionId },
      makeClerkConvexTokenFetcher((options) =>
        getTokenRef.current.key === key
          ? getTokenRef.current.getToken(options)
          : Promise.resolve(null),
      ),
    );
    setConnection({ key, lease });
    return () => lease.release();
  }, [key, url, userId, sessionId]);
  return {
    client: key !== null && connection?.key === key ? connection.lease.client : null,
    accountID: userId ?? "",
    url,
  };
}
