import { EnvironmentId, ProviderInstanceId } from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Atom } from "effect/unstable/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

describe("composer catalog query identity", () => {
  it("never reuses another environment, provider instance, or workspace's catalog", () => {
    const runtime = Atom.runtime(
      Layer.mergeAll(
        Layer.effect(EnvironmentRegistry, Effect.die("No query should run in this identity test")),
        Layer.effect(
          EnvironmentCacheStore,
          Effect.die("No cache should load in this identity test"),
        ),
      ),
    );
    const { composerCatalog } = createServerEnvironmentAtoms(runtime, {
      initialConfigValueAtom: () => Atom.make(null),
    });
    const target = {
      environmentId: EnvironmentId.make("environment-a"),
      input: {
        instanceId: ProviderInstanceId.make("claude-a"),
        cwd: "/project-a",
      },
    };
    expect(composerCatalog(target)).toBe(
      composerCatalog({ ...target, input: { ...target.input } }),
    );
    expect(composerCatalog(target)).not.toBe(
      composerCatalog({ ...target, environmentId: EnvironmentId.make("environment-b") }),
    );
    expect(composerCatalog(target)).not.toBe(
      composerCatalog({
        ...target,
        input: { ...target.input, instanceId: ProviderInstanceId.make("claude-b") },
      }),
    );
    expect(composerCatalog(target)).not.toBe(
      composerCatalog({ ...target, input: { ...target.input, cwd: "/project-b" } }),
    );
    expect(composerCatalog(target)).not.toBe(
      composerCatalog({ ...target, input: { ...target.input, cwd: null } }),
    );
  });
});
