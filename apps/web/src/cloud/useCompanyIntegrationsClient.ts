import { useEffect, useMemo } from "react";

import {
  makeCompanyIntegrationsClient,
  retainCompanyIntegrationsClient,
  type CompanyIntegrationsClient,
} from "./companyIntegrations";
import { useAuthenticatedConvexClient } from "./useAuthenticatedConvexClient";

export function useCompanyIntegrationsClient(): CompanyIntegrationsClient | null {
  const { client: shared, url } = useAuthenticatedConvexClient();
  const client = useMemo(
    () =>
      shared && url
        ? makeCompanyIntegrationsClient({
            convexUrl: url,
            client: shared,
            fetchToken: async () => null,
          })
        : null,
    [shared, url],
  );
  useEffect(
    () => (client === null ? undefined : retainCompanyIntegrationsClient(client)),
    [client],
  );
  return client;
}
