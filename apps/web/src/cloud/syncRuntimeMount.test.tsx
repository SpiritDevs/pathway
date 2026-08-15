import { isValidElement, Suspense, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { CloudSyncRuntimeMount } from "./syncRuntimeMount";

/**
 * Records when the runtime module is evaluated. A `vi.mock` factory runs on the first import of the
 * module it stands in for, so an untouched counter means nothing has imported it yet — which is the
 * whole point of the boundary: `./syncRuntime` drags in `convex/browser`, the sync engine, the
 * IndexedDB store and the leader election, and no deployment has the feature turned on.
 */
const runtimeModuleImports = vi.hoisted(() => ({ count: 0 }));

vi.mock("./syncRuntime", () => {
  runtimeModuleImports.count += 1;
  return { CloudSyncRuntime: () => null };
});

vi.mock("./publicConfig", () => ({
  hasCloudSyncPublicConfig: () => cloudSyncConfigured,
}));

let cloudSyncConfigured = false;

afterEach(() => {
  cloudSyncConfigured = false;
});

describe("CloudSyncRuntimeMount", () => {
  it("keeps the sync engine out of the chunk the entry module loads", () => {
    // Importing this module (at the top of this file) must not pull the runtime in with it.
    expect(runtimeModuleImports.count).toBe(0);
  });

  it("mounts nothing, and loads nothing, for a build without cloud sync", () => {
    expect(CloudSyncRuntimeMount()).toBeNull();
    expect(renderToStaticMarkup(<CloudSyncRuntimeMount />)).toBe("");
    expect(runtimeModuleImports.count).toBe(0);
  });

  it("loads the runtime on demand when the build has cloud sync configured", async () => {
    cloudSyncConfigured = true;

    const mounted = CloudSyncRuntimeMount();
    expect(isValidElement(mounted)).toBe(true);
    const boundary = mounted as ReactElement<{ readonly fallback: ReactNode }>;
    // An empty fallback, because the app renders beside this and must not wait on the chunk.
    expect(boundary.type).toBe(Suspense);
    expect(boundary.props.fallback).toBeNull();

    // Rendering is what asks for the chunk; the markup is empty either way.
    expect(renderToStaticMarkup(<CloudSyncRuntimeMount />)).toBe("");
    await vi.waitFor(() => {
      expect(runtimeModuleImports.count).toBe(1);
    });
  });
});
