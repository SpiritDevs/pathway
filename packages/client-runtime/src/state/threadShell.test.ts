import {
  EnvironmentId,
  ThreadId,
  ProviderDriverKind,
  type OrchestrationV2ShellSnapshot,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentCatalogState } from "./connections.ts";
import { v2ShellSnapshot, v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import { applyShellStreamEvent } from "./shellReducer.ts";
import { createEnvironmentThreadShellAtoms } from "./threadShell.ts";

const ENVIRONMENT_A = EnvironmentId.make("environment-a");
const ENVIRONMENT_B = EnvironmentId.make("environment-b");

function snapshot(prefix: string): OrchestrationV2ShellSnapshot {
  return {
    ...v2ShellSnapshot,
    threads: [1, 2, 3].map((index) => ({
      ...v2ThreadShell,
      id: ThreadId.make(`${prefix}-${index}`),
    })),
  };
}

describe("environment thread shell atoms", () => {
  it("rebuilds only what a single shell event touches", () => {
    const snapshotAtom = Atom.family((environmentId: EnvironmentId) =>
      Atom.make<OrchestrationV2ShellSnapshot | null>(
        snapshot(environmentId === ENVIRONMENT_A ? "a" : "b"),
      ),
    );
    const shell = createEnvironmentThreadShellAtoms({
      catalogValueAtom: Atom.make<EnvironmentCatalogState>({
        isReady: true,
        entries: new Map([
          [ENVIRONMENT_A, {} as never],
          [ENVIRONMENT_B, {} as never],
        ]),
      }),
      snapshotAtom,
    });
    const registry = AtomRegistry.make();
    const firstRef = { environmentId: ENVIRONMENT_A, threadId: ThreadId.make("a-1") };
    const secondRef = { environmentId: ENVIRONMENT_A, threadId: ThreadId.make("a-2") };
    const all = registry.get(shell.threadShellsAtom);
    const listB = registry.get(shell.environmentThreadShellsAtom(ENVIRONMENT_B));
    const byProject = registry.get(shell.environmentThreadRefsByProjectAtom(ENVIRONMENT_A));
    const first = registry.get(shell.threadShellAtom(firstRef));
    const second = registry.get(shell.threadShellAtom(secondRef));
    expect(all.map((thread) => thread.id)).toEqual(["a-1", "a-2", "a-3", "b-1", "b-2", "b-3"]);
    expect(all[0]).toBe(first);

    const current = registry.get(snapshotAtom(ENVIRONMENT_A))!;
    registry.set(
      snapshotAtom(ENVIRONMENT_A),
      applyShellStreamEvent(current, {
        kind: "thread.updated",
        sequence: 1,
        location: "active",
        thread: {
          ...current.threads[0]!,
          title: "Renamed",
          subagentComposerStates: [
            {
              childThreadId: ThreadId.make("child"),
              origin: "provider_native",
              driver: ProviderDriverKind.make("codex"),
              model: "gpt-5.4-mini",
              options: null,
            },
          ],
        },
      }),
    );

    const nextAll = registry.get(shell.threadShellsAtom);
    expect(nextAll.map((thread) => thread.id)).toEqual(all.map((thread) => thread.id));
    expect(nextAll[0]?.title).toBe("Renamed");
    expect(first?.subagentComposerStates).toBeUndefined();
    expect(nextAll[0]?.subagentComposerStates?.[0]).toMatchObject({
      childThreadId: "child",
      origin: "provider_native",
      model: "gpt-5.4-mini",
    });
    expect(registry.get(shell.threadShellAtom(firstRef))).toBe(nextAll[0]);
    expect(registry.get(shell.threadShellAtom(secondRef))).toBe(second);
    expect(registry.get(shell.environmentThreadShellsAtom(ENVIRONMENT_B))).toBe(listB);
    expect(registry.get(shell.environmentThreadRefsByProjectAtom(ENVIRONMENT_A))).toBe(byProject);
  });
});
