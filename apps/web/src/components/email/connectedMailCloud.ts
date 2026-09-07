import { useEffect, useState } from "react";
import type { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { subscribeMailWithDeadline, mailQueryErrorMessage } from "./connectedMailSubscription";
import { readMailRelayResponse } from "./connectedMail.logic";
import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import type { Value } from "convex/values";
import { activeCompanyIdAtom } from "../../cloud/activeCompany";
import { resolveCloudPublicConfig, resolveRelayClerkTokenOptions } from "../../cloud/publicConfig";
import { useBusinessToolsCloud } from "../contacts/businessToolsCloud";

export function useMailQuery<Result>(
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
    return subscribeMailWithDeadline<Result>(
      (receive, reject) =>
        client.onUpdate(makeFunctionReference<"query">(name), args, receive, reject),
      (value) => setState({ key, value }),
      (error) => setState({ key, error: mailQueryErrorMessage(error) }),
    );
    // Serialized arguments define the subscription and cancel any older scope's deadline.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, key]);
  return state.key === key ? state : { key };
}

export function useConnectedMailCloud() {
  const cloud = useBusinessToolsCloud();
  const companyId = useAtomValue(activeCompanyIdAtom);
  const { getToken } = useAuth();
  const relayUrl = resolveCloudPublicConfig().relayUrl;
  return {
    ...cloud,
    companyId,
    ready: Boolean(cloud.client && companyId && relayUrl),
    relayUrl,
    scope: `${cloud.accountID}:${companyId ?? ""}`,
    request: (name: string, args: Record<string, Value>) => {
      if (!companyId) return Promise.reject(new Error("Select a workspace to use Mail."));
      return cloud.request(name, { ...args, companyId });
    },
    relay: async <Result>(
      path: string,
      args: Record<string, Value>,
      method: "GET" | "POST" = "POST",
    ): Promise<Result> => {
      if (!relayUrl || !companyId)
        throw new Error("Sign in and select a Pathway Connect workspace.");
      const token = await getToken(resolveRelayClerkTokenOptions());
      if (!token) throw new Error("Sign in to connect your mailbox.");
      const response = await fetch(`${relayUrl}/v1/mail/${path}`, {
        method,
        credentials: "include",
        signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(method === "POST" ? { body: JSON.stringify({ ...args, companyId }) } : {}),
      });
      return (await readMailRelayResponse(response)) as Result;
    },
  };
}

export type ConnectedMailCloud = ReturnType<typeof useConnectedMailCloud>;
