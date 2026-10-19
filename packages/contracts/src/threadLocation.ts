import * as Schema from "effect/Schema";

/** Product views in which a thread is intentionally discoverable. */
export const ThreadLocation = Schema.Literals(["agents", "issues"]);
export type ThreadLocation = typeof ThreadLocation.Type;

/**
 * Threads created before locations shipped belong to the agent workspace. New producers persist
 * the marker explicitly; this fallback keeps older server snapshots visible where they were.
 */
export function threadIsVisibleAt(
  thread: { readonly locations?: ReadonlyArray<ThreadLocation> | undefined },
  location: ThreadLocation,
): boolean {
  return thread.locations?.includes(location) ?? location === "agents";
}
