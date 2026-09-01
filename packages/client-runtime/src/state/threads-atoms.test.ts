import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import type { EnvironmentCacheStore } from "../platform/persistence.ts";
import { THREAD_STATE_IDLE_TTL_MS } from "./threadRetention.ts";
import { createEnvironmentThreadStateAtoms, type ThreadSnapshotLoader } from "./threads.ts";

describe("createEnvironmentThreadStateAtoms", () => {
  it("retains thread state across short subscriber gaps", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader,
      never
    >;
    const threads = createEnvironmentThreadStateAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-1");
    const threadId = ThreadId.make("thread-1");
    const atom = threads.stateAtom(environmentId, threadId);

    expect(atom.idleTTL).toBe(THREAD_STATE_IDLE_TTL_MS);
    expect(threads.stateAtom(environmentId, threadId)).toBe(atom);
    expect(threads.stateAtom(environmentId, ThreadId.make("thread-2"))).not.toBe(atom);
    expect(threads.loadEnabledAtom(environmentId, threadId)).toBe(
      threads.loadEnabledAtom(environmentId, threadId),
    );
  });

  it("stops loading without subscribing to the environment thread source", () => {
    const runtime = Atom.runtime(Layer.empty) as unknown as Atom.AtomRuntime<
      EnvironmentRegistry | EnvironmentCacheStore | ThreadSnapshotLoader,
      never
    >;
    const threads = createEnvironmentThreadStateAtoms(runtime);
    const environmentId = EnvironmentId.make("environment-stopped");
    const threadId = ThreadId.make("thread-stopped");
    const registry = AtomRegistry.make();

    registry.set(threads.loadEnabledAtom(environmentId, threadId), false);

    const result = registry.get(threads.stateAtom(environmentId, threadId));
    expect(Option.getOrUndefined(AsyncResult.value(result))).toMatchObject({
      status: "stopped",
    });
    registry.dispose();
  });
});
