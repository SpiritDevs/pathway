import { useAuth } from "@clerk/react";
import { useEffect, useMemo, useRef } from "react";

import { makeEnvironmentControlClient, type EnvironmentControlClient } from "./environmentControl";
import { resolveCloudSyncConvexUrl } from "./publicConfig";
import { makeClerkConvexTokenFetcher } from "./syncTransportAuth";

/** Authenticated online company/environment administration shared by Settings and issue creation. */
export function useEnvironmentControl(): EnvironmentControlClient | null {
  const { getToken, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const convexUrl = resolveCloudSyncConvexUrl();
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const control = useMemo<EnvironmentControlClient | null>(() => {
    if (!isSignedIn || convexUrl === null) return null;
    return makeEnvironmentControlClient({
      convexUrl,
      fetchToken: (args) => makeClerkConvexTokenFetcher(getTokenRef.current)(args),
    });
  }, [convexUrl, isSignedIn]);

  useEffect(() => () => void control?.close(), [control]);
  return control;
}
