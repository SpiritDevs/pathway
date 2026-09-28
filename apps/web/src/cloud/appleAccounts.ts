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

/** Live Convex query; `args: null` skips the subscription. Data resets when the arguments change. */
export function useAppleCloudQuery<Query extends FunctionReference<"query">>(
  client: ConvexClient | null,
  query: Query,
  args: FunctionArgs<Query> | null,
): { readonly data: FunctionReturnType<Query> | undefined; readonly error: unknown } {
  const key = client && args ? JSON.stringify(args) : null;
  const [state, setState] = useState<{
    key: string | null;
    data: FunctionReturnType<Query> | undefined;
    error: unknown;
  }>({ key: null, data: undefined, error: undefined });
  useEffect(() => {
    if (!client || key === null) return;
    return client.onUpdate(
      query,
      JSON.parse(key) as FunctionArgs<Query>,
      (data) => setState({ key, data, error: undefined }),
      (error) => setState({ key, data: undefined, error }),
    );
  }, [client, key, query]);
  return state.key === key && key !== null
    ? { data: state.data, error: state.error }
    : { data: undefined, error: undefined };
}
