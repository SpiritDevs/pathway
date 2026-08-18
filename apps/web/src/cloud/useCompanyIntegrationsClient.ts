import { useAuth } from "@clerk/react";
import { useEffect, useMemo, useRef } from "react";

import {
  makeCompanyIntegrationsClient,
  type CompanyIntegrationsClient,
} from "./companyIntegrations";
import { resolveCloudSyncConvexUrl } from "./publicConfig";
import { makeClerkConvexTokenFetcher } from "./syncTransportAuth";

export function useCompanyIntegrationsClient(): CompanyIntegrationsClient | null {
  const { getToken, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const convexUrl = resolveCloudSyncConvexUrl();
  const client = useMemo(
    () =>
      !isSignedIn || convexUrl === null
        ? null
        : makeCompanyIntegrationsClient({
            convexUrl,
            fetchToken: (args) => makeClerkConvexTokenFetcher(getTokenRef.current)(args),
          }),
    [convexUrl, isSignedIn],
  );
  useEffect(() => () => void client?.close(), [client]);
  return client;
}
