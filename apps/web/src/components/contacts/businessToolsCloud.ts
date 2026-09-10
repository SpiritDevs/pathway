import { useAuth } from "@clerk/react";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { useEffect, useState } from "react";
import { resolveCloudSyncConvexUrl } from "../../cloud/publicConfig";
import { makeClerkConvexTokenFetcher } from "../../cloud/syncTransportAuth";

export function useBusinessToolsCloud() {
  const { getToken, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const url = resolveCloudSyncConvexUrl();
  const [connection, setConnection] = useState<{
    client: ConvexClient;
    accountID: string;
    url: string;
  } | null>(null);
  useEffect(() => {
    if (!url || !isSignedIn || !userId) {
      setConnection(null);
      return;
    }
    const client = new ConvexClient(url);
    client.setAuth(makeClerkConvexTokenFetcher(getToken));
    setConnection({ client, accountID: userId, url });
    return () => {
      void client.close();
    };
  }, [url, isSignedIn, userId, getToken]);
  const client =
    isSignedIn && connection?.accountID === userId && connection.url === url
      ? connection.client
      : null;
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
