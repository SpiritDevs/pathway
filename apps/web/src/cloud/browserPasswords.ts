import type { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { useAuthenticatedConvexClient } from "./useAuthenticatedConvexClient";

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
  return useAuthenticatedConvexClient().client;
}
