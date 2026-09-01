import { useAuth } from "@clerk/react";
import type { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { useMemo } from "react";

import { resolveCloudSyncConvexUrl } from "./publicConfig";
import { makeClerkConvexTokenFetcher } from "./syncTransportAuth";

const removeMissingAgentThread = makeFunctionReference<
  "mutation",
  {
    readonly companyId: CompanyId;
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  },
  null
>("agentThreads:removeMissing");

export interface AgentThreadAdmin {
  readonly removeMissing: (input: {
    readonly companyId: CompanyId;
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }) => Promise<void>;
}

/** One-shot cloud cleanup for a shell whose owning environment confirmed the thread is absent. */
export function useAgentThreadAdmin(): AgentThreadAdmin | null {
  const { getToken, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const convexUrl = resolveCloudSyncConvexUrl();
  return useMemo(() => {
    if (!isSignedIn || convexUrl === null) return null;
    const fetchToken = makeClerkConvexTokenFetcher(getToken);
    return {
      removeMissing: async (input) => {
        const token = await fetchToken({ forceRefreshToken: false });
        if (!token) throw new Error("Cloud authentication is unavailable.");
        const client = new ConvexHttpClient(convexUrl);
        client.setAuth(token);
        await client.mutation(removeMissingAgentThread, input);
      },
    };
  }, [convexUrl, getToken, isSignedIn]);
}
