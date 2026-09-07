import { useAuth } from "@clerk/react";
import { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { useEffect, useRef, useState } from "react";
import { resolveCloudSyncConvexUrl } from "./publicConfig";
import { makeClerkConvexTokenFetcher } from "./syncTransportAuth";

export interface BrowserPasswordMetadata {
  id: string;
  label: string;
  origin: string;
  username: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}
export const browserPasswordFunctions = {
  list: makeFunctionReference<"query", { origin?: string }, BrowserPasswordMetadata[]>(
    "browserPasswords:list",
  ),
  save: makeFunctionReference<
    "action",
    {
      id?: string;
      label: string;
      origin: string;
      username: string;
      password: string;
      expectedRevision?: number;
    },
    BrowserPasswordMetadata
  >("browserPasswords:save"),
  remove: makeFunctionReference<"mutation", { id: string; expectedRevision: number }, null>(
    "browserPasswords:remove",
  ),
  getForAutofill: makeFunctionReference<
    "action",
    { id: string; origin: string },
    { id: string; origin: string; username: string; password: string }
  >("browserPasswords:getForAutofill"),
};

/** A personal account connection. Passwords never enter the replicated company store. */
export function useBrowserPasswordClient(): ConvexClient | null {
  const { getToken, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const getTokenRef = useRef(getToken);
  getTokenRef.current = getToken;
  const url = resolveCloudSyncConvexUrl();
  const [connection, setConnection] = useState<{
    client: ConvexClient;
    userId: string;
    url: string;
  }>();
  useEffect(() => {
    if (!isSignedIn || !userId || !url) return;
    const client = new ConvexClient(url);
    client.setAuth((options) => makeClerkConvexTokenFetcher(getTokenRef.current)(options));
    setConnection({ client, userId, url });
    return () => {
      void client.close();
    };
  }, [isSignedIn, userId, url]);
  return isSignedIn && userId === connection?.userId && url === connection.url
    ? connection.client
    : null;
}
