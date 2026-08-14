/**
 * The cloud-sync capability gate.
 *
 * Everything in this deployment ships disabled: no client reads it, and every entry point refuses
 * until a deployment sets `PATHWAY_CLOUD_SYNC=enabled`. That keeps the schema and functions
 * landable ahead of the rollout without changing behavior for anyone.
 *
 * @module lib/capability
 */
import { backendError } from "./errors.ts";

export const CLOUD_SYNC_CAPABILITY_ENV = "PATHWAY_CLOUD_SYNC";

export function isCloudSyncEnabled(): boolean {
  return process.env[CLOUD_SYNC_CAPABILITY_ENV] === "enabled";
}

export function requireCloudSyncEnabled(): void {
  if (isCloudSyncEnabled()) return;
  throw backendError(
    "cloud-sync-disabled",
    "Cloud sync is not enabled for this deployment. Set PATHWAY_CLOUD_SYNC=enabled to turn it on.",
  );
}
