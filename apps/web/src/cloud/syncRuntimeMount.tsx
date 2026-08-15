/**
 * The load boundary in front of the cloud-sync runtime.
 *
 * `cloud/syncRuntime` pulls in `convex/browser` and the whole sync engine — a WebSocket client, the
 * IndexedDB store, the leader election, the issue adapter — none of which any deployment uses
 * today, because cloud sync is off unless a build sets both `VITE_PATHWAY_CLOUD_SYNC` and a Convex
 * URL. Importing it from the entry module would put all of that in the first chunk every visitor
 * downloads and parses before the app can paint. Behind a dynamic import it is a separate chunk
 * that is fetched only by a build that has the feature on, and only once the app is running.
 *
 * @module cloud/syncRuntimeMount
 */
import { lazy, Suspense, type ReactNode } from "react";

import { hasCloudSyncPublicConfig } from "./publicConfig";

const LazyCloudSyncRuntime = lazy(async () => {
  const module = await import("./syncRuntime");
  return { default: module.CloudSyncRuntime };
});

/**
 * Mounts the cloud-sync runtime when this build has the feature configured, and nothing otherwise.
 *
 * It renders as a *sibling* of the app rather than a wrapper: the runtime component renders no UI,
 * and a wrapper would make the app tree wait on — and remount after — the chunk it is suspended on.
 * With the fallback empty, a slow chunk is invisible instead of a blank screen.
 */
export function CloudSyncRuntimeMount(): ReactNode {
  if (!hasCloudSyncPublicConfig()) return null;
  return (
    <Suspense fallback={null}>
      <LazyCloudSyncRuntime />
    </Suspense>
  );
}
