import type { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import type { Value } from "convex/values";
import { useEffect, useState } from "react";
import { useAuthenticatedConvexClient } from "../../cloud/useAuthenticatedConvexClient";

export function useBusinessToolsCloud() {
  const { client, accountID } = useAuthenticatedConvexClient();
  return {
    client,
    accountID,
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
  const [state, setState] = useState<{
    key: string;
    client: ConvexClient | null;
    value?: Result;
    error?: string;
  }>({ key, client });
  useEffect(() => {
    setState({ key, client });
    if (!client || !args) return;
    return client.onUpdate(
      makeFunctionReference<"query">(name),
      args,
      (value: Result) => setState({ key, client, value }),
      (error: Error) => setState({ key, client, error: error.message }),
    );
    // Serialized args define the subscription; callers need no object memoization.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  return state.key === key && state.client === client ? state : { key, client };
}
