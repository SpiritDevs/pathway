import { createEnvironmentThreadShellAtoms } from "@spiritdevs/client-runtime/state/threads";
import {
  EnvironmentId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@spiritdevs/contracts";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture } from "../test-fixtures";

describe("personal conversation discovery", () => {
  it("shows shared conversations before connecting and drops revoked discovery", () => {
    const environmentId = EnvironmentId.make("shared-environment");
    const threadId = ThreadId.make("shared-conversation");
    const discovery = Atom.make<ReadonlyArray<EnvironmentId>>([environmentId]);
    const shell = { ...makeThreadFixture().source, id: threadId, projectId: null };
    const shells = createEnvironmentThreadShellAtoms({
      catalogValueAtom: Atom.make({ isReady: true, entries: new Map() }),
      discoveryEnvironmentIdsAtom: discovery,
      snapshotAtom: Atom.family(() => Atom.make<OrchestrationV2ShellSnapshot | null>(null)),
      fallbackThreadsAtom: Atom.family(() =>
        Atom.make<ReadonlyArray<OrchestrationV2ThreadShell>>([shell]),
      ),
    });
    const registry = AtomRegistry.make();
    const unmount = registry.mount(shells.threadRefsAtom);
    try {
      expect(registry.get(shells.threadRefsAtom)).toEqual([{ environmentId, threadId }]);
      expect(registry.get(shells.threadShellsAtom)[0]?.projectId).toBeNull();
      registry.set(discovery, []);
      expect(registry.get(shells.threadRefsAtom)).toEqual([]);
    } finally {
      unmount();
      registry.dispose();
    }
  });
});
