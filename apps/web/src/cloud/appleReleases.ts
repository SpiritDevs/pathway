import type { ReleaseIntent, ReleaseTarget } from "@spiritdevs/contracts/releases";
import { makeFunctionReference } from "convex/server";

export interface ReleasePublishingSettings {
  readonly enabled: boolean;
  readonly revision: number;
}

/**
 * Publishing consent lives in Cloud and only accepts the member's own identity. Environments and
 * agents can prepare an intent, but only these client calls can enable publishing or confirm one.
 */
export const appleReleaseFunctions = {
  settings: makeFunctionReference<"query", ReleaseTarget, ReleasePublishingSettings>(
    "appleReleases:settings",
  ),
  setEnabled: makeFunctionReference<
    "mutation",
    ReleaseTarget & { enabled: boolean; expectedRevision: number },
    null
  >("appleReleases:setEnabled"),
  intent: makeFunctionReference<"query", { intentId: string }, ReleaseIntent>(
    "appleReleases:intent",
  ),
  /** Only after an explicit click in the confirmation dialog. Never automatic, never an agent tool. */
  confirm: makeFunctionReference<"mutation", { intentId: string }, ReleaseIntent>(
    "appleReleases:confirm",
  ),
  cancel: makeFunctionReference<"mutation", { intentId: string }, null>("appleReleases:cancel"),
};
