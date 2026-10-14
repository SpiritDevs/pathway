import type { TerminalSummary } from "@spiritdevs/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity";
import { expect, it, vi } from "vite-plus/test";

const metadata = vi.hoisted(() => ({ atom: null as unknown }));
vi.mock("./terminal", () => ({ terminalEnvironment: { metadata: () => metadata.atom } }));

const { threadRunningTerminalIdsAtom } = await import("./terminalSessions");

const summary = (threadId: string, terminalId: string, hasRunningSubprocess = true) =>
  ({ threadId, terminalId, hasRunningSubprocess }) as unknown as TerminalSummary;

it("scopes running terminals to one thread and ignores updates for other threads", () => {
  const source = Atom.make(
    AsyncResult.success<ReadonlyArray<TerminalSummary>>([
      summary("a", "term-10"),
      summary("a", "term-2"),
      summary("a", "term-3", false),
      summary("b", "term-1"),
    ]),
  );
  metadata.atom = source;
  const registry = AtomRegistry.make();
  try {
    const threadA = threadRunningTerminalIdsAtom(JSON.stringify(["env", "a"]));
    const threadB = threadRunningTerminalIdsAtom(JSON.stringify(["env", "b"]));
    const notifications = vi.fn();
    registry.subscribe(threadA, notifications);
    registry.subscribe(threadB, () => {});
    const before = registry.get(threadA);
    expect(before).toEqual(["term-2", "term-10"]);
    expect(registry.get(threadB)).toEqual(["term-1"]);
    notifications.mockClear();

    registry.set(
      source,
      AsyncResult.success([
        summary("a", "term-10"),
        summary("a", "term-2"),
        summary("a", "term-3", false),
        summary("b", "term-1", false),
      ]),
    );
    expect(registry.get(threadA)).toBe(before);
    expect(notifications).not.toHaveBeenCalled();
    expect(registry.get(threadB)).toEqual([]);
  } finally {
    registry.dispose();
  }
});
