import { useAuth } from "@clerk/react";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { useEffect, useMemo, useState } from "react";
import { resolveCloudSyncConvexUrl } from "../../cloud/publicConfig";
import { makeClerkConvexTokenFetcher } from "../../cloud/syncTransportAuth";

export function useBusinessToolsCloud() {
  const { getToken, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const url = resolveCloudSyncConvexUrl();
  const client = useMemo(() => {
    if (!url || !isSignedIn || !userId) return null;
    const next = new ConvexClient(url);
    next.setAuth(makeClerkConvexTokenFetcher(getToken));
    return next;
  }, [url, isSignedIn, userId, getToken]);
  useEffect(
    () => () => {
      void client?.close();
    },
    [client],
  );
  return {
    client,
    accountID: userId ?? "",
    request: async (name: string, args: Record<string, Value>) => {
      if (!client) throw new Error("Sign in to your workspace to save changes.");
      if (!navigator.onLine) throw new Error("You are offline. Reconnect and retry this change.");
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          client.mutation(makeFunctionReference<"mutation">(name), args),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () =>
                reject(new Error("The server has not confirmed this change. Reconnect and retry.")),
              15_000,
            );
          }),
        ]);
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    },
  };
}

export function useBusinessToolsQuery<Result>(
  client: ConvexClient | null,
  scope: string,
  name: string,
  args: Record<string, Value> | null,
) {
  const key = `${scope}:${name}:${JSON.stringify(args)}`;
  const [state, setState] = useState<{ key: string; value?: Result; error?: string }>({ key });
  useEffect(() => {
    setState({ key });
    if (!client || !args) return;
    return client.onUpdate(
      makeFunctionReference<"query">(name),
      args,
      (value: Result) => setState({ key, value }),
      (error: Error) => setState({ key, error: error.message }),
    );
    // Serialized args define the subscription; callers need no object memoization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  return state.key === key ? state : { key };
}
