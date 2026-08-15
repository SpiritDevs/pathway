import { useAuth } from "@clerk/react";
import { useEffect, useMemo } from "react";

import {
  makeEnvironmentControlClient,
  type EnvironmentControlClient,
} from "../../../cloud/environmentControl";
import { resolveCloudSyncConvexUrl } from "../../../cloud/publicConfig";
import { makeClerkConvexTokenFetcher } from "../../../cloud/syncTransportAuth";

export function useEnvironmentControl(): EnvironmentControlClient | null {
  const { getToken, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const convexUrl = resolveCloudSyncConvexUrl();
  const control = useMemo<EnvironmentControlClient | null>(() => {
    if (!isSignedIn || convexUrl === null) return null;
    return makeEnvironmentControlClient({
      convexUrl,
      fetchToken: makeClerkConvexTokenFetcher(getToken),
    });
  }, [convexUrl, getToken, isSignedIn]);

  useEffect(() => {
    return () => {
      void control?.close();
    };
  }, [control]);

  return control;
}
