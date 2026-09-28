import type {
  AppleAccount as AppleAccountSchema,
  AppleAccountCreateInput,
  AppleAccountInput,
  AppleAccountRemoveInput,
  AppleAccountUpdateInput,
  AppleCloudStatus as AppleCloudStatusSchema,
  AppleConnectInput,
  AppleIntegration,
  AppleLinkProjectInput,
  AppleListAccountsInput,
  AppleProjectInput,
  AppleProjectLink as AppleProjectLinkSchema,
  AppleRevokeInput,
  AppleTeam as AppleTeamSchema,
  AppleTeamInput,
  AppleTeamUpsertInput,
} from "@spiritdevs/contracts/apple";
import type { ConvexClient } from "convex/browser";
import {
  getFunctionName,
  makeFunctionReference,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import { useEffect, useState } from "react";
import { useAuthenticatedConvexClient } from "./useAuthenticatedConvexClient";

export type AppleAccount = typeof AppleAccountSchema.Type;
export type AppleTeam = typeof AppleTeamSchema.Type;
export type AppleCloudStatus = typeof AppleCloudStatusSchema.Type;
export type AppleProjectLink = typeof AppleProjectLinkSchema.Type;

export const appleAccountFunctions = {
  listAccounts: makeFunctionReference<
    "query",
    typeof AppleListAccountsInput.Type,
    ReadonlyArray<AppleAccount>
  >("appleIntegrations:listAccounts"),
  createAccount: makeFunctionReference<
    "mutation",
    typeof AppleAccountCreateInput.Type,
    AppleAccount
  >("appleIntegrations:createAccount"),
  accountStatus: makeFunctionReference<"query", typeof AppleAccountInput.Type, AppleAccount>(
    "appleIntegrations:accountStatus",
  ),
  updateAccount: makeFunctionReference<
    "mutation",
    typeof AppleAccountUpdateInput.Type,
    AppleAccount
  >("appleIntegrations:updateAccount"),
  removeAccount: makeFunctionReference<"mutation", typeof AppleAccountRemoveInput.Type, null>(
    "appleIntegrations:removeAccount",
  ),
  listTeams: makeFunctionReference<
    "query",
    typeof AppleAccountInput.Type,
    ReadonlyArray<AppleTeam>
  >("appleIntegrations:listTeams"),
  upsertTeam: makeFunctionReference<"mutation", typeof AppleTeamUpsertInput.Type, AppleTeam>(
    "appleIntegrations:upsertTeam",
  ),
  /** Validates the key with a live ASC call before it replaces the team's current key. */
  connect: makeFunctionReference<"action", typeof AppleConnectInput.Type, AppleIntegration>(
    "appleIntegrations:connect",
  ),
  revoke: makeFunctionReference<"mutation", typeof AppleRevokeInput.Type, AppleIntegration>(
    "appleIntegrations:revoke",
  ),
  /** Removes the team, its key and leases; fails while projects link it. Takes the key revision. */
  removeTeam: makeFunctionReference<"mutation", typeof AppleRevokeInput.Type, null>(
    "appleIntegrations:removeTeam",
  ),
  status: makeFunctionReference<"query", typeof AppleTeamInput.Type, AppleCloudStatus>(
    "appleIntegrations:status",
  ),
  linkProject: makeFunctionReference<"action", typeof AppleLinkProjectInput.Type, AppleProjectLink>(
    "appleIntegrations:linkProject",
  ),
  unlinkProject: makeFunctionReference<"mutation", typeof AppleProjectInput.Type, null>(
    "appleIntegrations:unlinkProject",
  ),
  projectLink: makeFunctionReference<
    "query",
    typeof AppleProjectInput.Type,
    AppleProjectLink | null
  >("appleIntegrations:projectLink"),
};

/** The member's own Convex identity. Apple accounts and keys never use an environment identity. */
export function useAppleAccountsClient(): ConvexClient | null {
  return useAuthenticatedConvexClient().client;
}

export interface AppleCloudQueryState<Data> {
  readonly client: object | null;
  readonly key: string | null;
  readonly data: Data | undefined;
  readonly error: unknown;
}

/** State is only valid for the client identity and query arguments that produced it. */
export function selectAppleCloudQueryState<Data>(
  state: AppleCloudQueryState<Data>,
  client: object | null,
  key: string | null,
): { readonly data: Data | undefined; readonly error: unknown } {
  return client !== null && key !== null && state.client === client && state.key === key
    ? { data: state.data, error: state.error }
    : { data: undefined, error: undefined };
}

/** Subscribes to one query. Callbacks that arrive after unsubscribing are dropped. */
export function subscribeAppleCloudQuery<Query extends FunctionReference<"query">>(
  client: Pick<ConvexClient, "onUpdate">,
  query: Query,
  args: FunctionArgs<Query>,
  onState: (next: {
    readonly data: FunctionReturnType<Query> | undefined;
    readonly error: unknown;
  }) => void,
): () => void {
  let active = true;
  const unsubscribe = client.onUpdate(
    query,
    args,
    (data) => {
      if (active) onState({ data, error: undefined });
    },
    (error) => {
      if (active) onState({ data: undefined, error });
    },
  );
  return () => {
    active = false;
    unsubscribe();
  };
}

/** Live Convex query; `args: null` skips the subscription. Data resets when the client or arguments change. */
export function useAppleCloudQuery<Query extends FunctionReference<"query">>(
  client: ConvexClient | null,
  query: Query,
  args: FunctionArgs<Query> | null,
): { readonly data: FunctionReturnType<Query> | undefined; readonly error: unknown } {
  const key = client && args ? JSON.stringify([getFunctionName(query), args]) : null;
  const [state, setState] = useState<AppleCloudQueryState<FunctionReturnType<Query>>>({
    client: null,
    key: null,
    data: undefined,
    error: undefined,
  });
  useEffect(() => {
    if (!client || key === null) return;
    const [, parsedArgs] = JSON.parse(key) as [string, FunctionArgs<Query>];
    return subscribeAppleCloudQuery(client, query, parsedArgs, (next) =>
      setState({ client, key, ...next }),
    );
  }, [client, key, query]);
  return selectAppleCloudQueryState(state, client, key);
}
