import { describe, expect, it, vi } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Layer from "effect/Layer";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAssetEnvironmentAtoms,
  InvalidAssetCollectionKeyError,
  parseAssetCollectionKey,
  resolveCurrentAssetUrl,
} from "./assets.ts";

const NOW = 1_000_000;

describe("asset collection keys", () => {
  it("preserves malformed JSON and its native cause", () => {
    const key = "not-json";
    let error: unknown;

    try {
      parseAssetCollectionKey(key);
    } catch (cause) {
      error = cause;
    }

    expect(error).toBeInstanceOf(InvalidAssetCollectionKeyError);
    expect(error).toMatchObject({ key, cause: expect.any(SyntaxError) });
  });

  it("rejects invalid asset collection shapes", () => {
    const key = JSON.stringify(["environment-1", [{ _tag: "unknown" }]]);

    expect(() => parseAssetCollectionKey(key)).toThrowError(InvalidAssetCollectionKeyError);
  });
});

describe("resolveCurrentAssetUrl", () => {
  it("resolves a freshly issued URL against the active environment", () => {
    expect(
      resolveCurrentAssetUrl(
        "https://environment.test/base",
        { relativeUrl: "/api/assets/signed/image.png", expiresAt: NOW + 3_600_000 },
        NOW,
      ),
    ).toBe("https://environment.test/api/assets/signed/image.png");
  });

  it("refuses expired URLs and URLs inside the request safety window", () => {
    expect(
      resolveCurrentAssetUrl(
        "https://environment.test",
        { relativeUrl: "/api/assets/signed/image.png", expiresAt: NOW - 1 },
        NOW,
      ),
    ).toBeNull();
    expect(
      resolveCurrentAssetUrl(
        "https://environment.test",
        { relativeUrl: "/api/assets/signed/image.png", expiresAt: NOW + 60_000 },
        NOW,
      ),
    ).toBeNull();
  });
});

describe("createAssetEnvironmentAtoms", () => {
  it("releases a signed URL query when its last view unmounts", async () => {
    vi.useFakeTimers();
    try {
      const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
        EnvironmentRegistry,
        never
      >;
      const assets = createAssetEnvironmentAtoms(runtime);
      const atom = assets.createUrl({
        environmentId: EnvironmentId.make("environment-1"),
        input: { resource: { _tag: "attachment", attachmentId: "attachment-1" } },
      });
      const registry = AtomRegistry.make();
      const unsubscribe = registry.subscribe(atom, () => undefined);

      expect(registry.getNodes().has(atom)).toBe(true);
      unsubscribe();
      await vi.advanceTimersByTimeAsync(0);

      expect(registry.getNodes().has(atom)).toBe(false);
      registry.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("releases gallery URL queries when their view unmounts", async () => {
    vi.useFakeTimers();
    try {
      const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
        EnvironmentRegistry,
        never
      >;
      const assets = createAssetEnvironmentAtoms(runtime);
      const environmentId = EnvironmentId.make("environment-1");
      const resources = [
        { _tag: "attachment" as const, attachmentId: "attachment-1" },
        { _tag: "attachment" as const, attachmentId: "attachment-2" },
      ];
      const collection = assets.createUrls({ environmentId, resources });
      const queries = resources.map((resource) =>
        assets.createUrl({ environmentId, input: { resource } }),
      );
      const registry = AtomRegistry.make();
      const unsubscribe = registry.subscribe(collection, () => undefined);
      registry.get(collection);

      expect(registry.getNodes().has(collection)).toBe(true);
      expect(queries.every((query) => registry.getNodes().has(query))).toBe(true);
      unsubscribe();
      await vi.advanceTimersByTimeAsync(0);

      expect(registry.getNodes().has(collection)).toBe(false);
      expect(queries.every((query) => !registry.getNodes().has(query))).toBe(true);
      registry.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keys asset URL queries by environment and resource", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const assets = createAssetEnvironmentAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const originalTarget = {
      environmentId,
      input: {
        resource: {
          _tag: "project-favicon" as const,
          cwd: "/repo/original",
        },
      },
    };

    expect(assets.createUrl(originalTarget)).toBe(
      assets.createUrl({
        environmentId,
        input: {
          resource: {
            _tag: "project-favicon",
            cwd: "/repo/original",
          },
        },
      }),
    );
    expect(
      assets.createUrl({
        environmentId,
        input: {
          resource: {
            _tag: "project-favicon",
            cwd: "/repo/next",
          },
        },
      }),
    ).not.toBe(assets.createUrl(originalTarget));
    expect(
      assets.createUrl({
        environmentId,
        input: {
          resource: {
            _tag: "project-favicon",
            cwd: "/repo/original",
            path: "brand/icon.svg",
          },
        },
      }),
    ).not.toBe(assets.createUrl(originalTarget));
    expect(
      assets.createUrl({
        environmentId: EnvironmentId.make("environment-2"),
        input: originalTarget.input,
      }),
    ).not.toBe(assets.createUrl(originalTarget));
  });

  it("keys collections while preserving independent resource queries", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry,
      never
    >;
    const assets = createAssetEnvironmentAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const resources = [
      { _tag: "attachment" as const, attachmentId: "attachment-1" },
      { _tag: "attachment" as const, attachmentId: "attachment-2" },
    ];

    expect(assets.createUrls({ environmentId, resources })).toBe(
      assets.createUrls({
        environmentId,
        resources: resources.map((resource) => ({ ...resource })),
      }),
    );
    expect(
      assets.createUrls({
        environmentId,
        resources: [...resources].toReversed(),
      }),
    ).not.toBe(assets.createUrls({ environmentId, resources }));
  });
});
