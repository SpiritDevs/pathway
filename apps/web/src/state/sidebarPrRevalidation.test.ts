import type { EnvironmentProject } from "@spiritdevs/client-runtime/state/shell";
import { scopeThreadRef, scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import { AsyncResult, AtomRegistry } from "effect/unstable/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { makeThreadFixture } from "../test-fixtures";
import { createSidebarPrRevalidation } from "./sidebarPrRevalidation";
import { threadChangeRequestSource, type ThreadChangeRequestState } from "./threadPullRequest";
import { updateSidebarChangeRequest } from "./sidebarThreadLifecycle";

const mocks = vi.hoisted(() => ({ command: vi.fn(), query: vi.fn() }));
vi.mock("@spiritdevs/client-runtime/state/runtime", async (original) => ({
  ...(await original<typeof import("@spiritdevs/client-runtime/state/runtime")>()),
  runAtomCommand: mocks.command,
  executeAtomQuery: mocks.query,
}));
vi.mock("./vcs", () => ({ vcsEnvironment: { refreshStatus: "refresh-status" } }));
vi.mock("./pullRequests", () => ({
  pullRequestEnvironment: { invalidate: "invalidate", detail: (target: unknown) => target },
}));

const thread = makeThreadFixture({ branch: "work", worktreePath: "/work" });
const openStatus = AsyncResult.success({
  refName: "work",
  pr: { state: "open", url: "https://github.com/example/repo/pull/2" },
});
const history = Array.from({ length: 106 }, (_, index) => ({
  ...thread,
  id: ThreadId.make(`history-${index}`),
}));
const keyFor = (item: typeof thread) =>
  scopedThreadKey(scopeThreadRef(item.environmentId, item.id));
const statesFor = (threads: typeof history, checkedAt?: number) =>
  new Map(
    threads.map((item) => [
      keyFor(item),
      { source: threadChangeRequestSource(item), state: "merged" as const, checkedAt },
    ]),
  );
let cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(1_000_000);
  mocks.command.mockResolvedValue(openStatus);
});
afterEach(() => {
  cleanup.forEach((stop) => stop());
  cleanup = [];
  vi.restoreAllMocks();
});
function mount() {
  const registry = AtomRegistry.make();
  const pass = createSidebarPrRevalidation(registry);
  cleanup.push(() => {
    pass.stop();
    registry.dispose();
  });
  return pass;
}
const inputFor = (threads = [thread]) => ({
  threads,
  projects: [] as ReadonlyArray<EnvironmentProject>,
  retainedStates: statesFor(threads),
  onResult: vi.fn(),
});

it("rechecks stale retained branches without mounting rows and stamps conclusive results", async () => {
  const input = inputFor();
  await mount().update(input);
  expect(mocks.command.mock.calls[0]?.[1]).toBe("refresh-status");
  expect(input.onResult.mock.calls).toEqual([
    [
      keyFor(thread),
      { source: threadChangeRequestSource(thread), state: "open", checkedAt: Date.now() },
      false,
    ],
  ]);
});

it("shares one host read across all 106 threads targeting the same worktree, through the entire pass", async () => {
  const input = inputFor(history);
  await mount().update(input);
  expect(input.onResult).toHaveBeenCalledTimes(106);
  expect(mocks.command).toHaveBeenCalledTimes(1);
});

it("skips fresh history on repeated remounts and revalidates after five minutes", async () => {
  mocks.command.mockResolvedValue(
    AsyncResult.success({
      refName: "work",
      pr: { state: "merged", url: "https://github.com/example/repo/pull/2" },
    }),
  );
  let retainedStates: ReadonlyMap<string, ThreadChangeRequestState> = statesFor(
    history,
    Date.now(),
  );
  const onResult = vi.fn((key: string, value: ThreadChangeRequestState, failed?: boolean) => {
    retainedStates = updateSidebarChangeRequest(retainedStates, key, value, failed);
  });
  const run = async () => {
    const pass = mount();
    await pass.update({ ...inputFor(history), retainedStates, onResult });
    pass.stop();
  };
  for (let i = 0; i < 5; i++) await run();
  expect(mocks.command).not.toHaveBeenCalled();
  vi.mocked(Date.now).mockReturnValue(1_300_000);
  await run();
  expect(onResult).toHaveBeenCalledTimes(106);
  expect(mocks.command).toHaveBeenCalledTimes(1);
  await run();
  expect(mocks.command).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  "retries after reconnection when a failed read finishes late: %s",
  async (finishAfterReconnect) => {
    const failedRead = deferred<unknown>();
    mocks.command.mockReturnValueOnce(failedRead.promise);
    const input = inputFor();
    const pass = mount();
    const first = pass.update(input);
    if (!finishAfterReconnect) {
      failedRead.resolve(AsyncResult.fail(new Error("disconnected")));
      await first;
      expect(input.onResult).toHaveBeenLastCalledWith(
        keyFor(thread),
        expect.not.objectContaining({ checkedAt: expect.anything() }),
        true,
      );
      await pass.update(input);
      expect(mocks.command).toHaveBeenCalledTimes(1);
    }
    const disconnected = pass.update({ ...input, threads: [] });
    const reconnected = pass.update(input);
    if (finishAfterReconnect) failedRead.resolve(AsyncResult.fail(new Error("disconnected")));
    await Promise.all([first, disconnected, reconnected]);
    expect(mocks.command).toHaveBeenCalledTimes(2);
    expect(input.onResult).toHaveBeenLastCalledWith(
      keyFor(thread),
      expect.objectContaining({ state: "open", checkedAt: Date.now() }),
      false,
    );
  },
);

it("bounds concurrent work and stops queued history reads when the sidebar leaves", async () => {
  const pending = Array.from({ length: 4 }, () => deferred<unknown>());
  mocks.command.mockImplementation(() => pending[mocks.command.mock.calls.length - 1]!.promise);
  const input = inputFor(
    history.map((item, index) => ({ ...item, worktreePath: `/work/${index}` })),
  );
  const pass = mount();
  const complete = pass.update(input);
  expect(mocks.command).toHaveBeenCalledTimes(4);
  pass.stop();
  for (const entry of pending) entry.resolve(openStatus);
  await complete;
  expect(input.onResult).not.toHaveBeenCalled();
  expect(mocks.command).toHaveBeenCalledTimes(4);
});

it("never shares reads between environments or publishes a superseded branch result", async () => {
  const pending = deferred<unknown>();
  mocks.command.mockReturnValueOnce(pending.promise);
  const input = inputFor([thread, { ...thread, environmentId: EnvironmentId.make("other") }]);
  const pass = mount();
  const first = pass.update(input);
  const second = pass.update(inputFor([{ ...thread, branch: "changed" }]));
  pending.resolve(openStatus);
  await Promise.all([first, second]);
  expect(mocks.command).toHaveBeenCalledTimes(2);
  expect(input.onResult).not.toHaveBeenCalled();
});

it("shares attached PR invalidation and detail reads and retries a failed invalidation", async () => {
  const attachment = { number: 110, url: "https://github.com/SpiritDevs/pathway/pull/110" };
  const threads = history.map((item) => ({
    ...item,
    branch: null,
    attachedPullRequest: attachment,
  }));
  const projects = [
    {
      environmentId: thread.environmentId,
      id: thread.projectId,
      repositoryIdentity: {
        provider: "github",
        canonicalKey: "github.com/SpiritDevs/pathway",
        displayName: "SpiritDevs/pathway",
      },
    },
  ] as unknown as ReadonlyArray<EnvironmentProject>;
  mocks.command.mockRejectedValueOnce(new Error("disconnected"));
  mocks.query.mockResolvedValue(AsyncResult.success({ ...attachment, state: "open" }));
  const pass = mount();
  const input = { ...inputFor(threads.slice(0, 1)), projects };
  await pass.update(input);
  expect(mocks.query).not.toHaveBeenCalled();
  await pass.update({ ...input, threads: [] });
  const reconnected = { ...inputFor(threads), projects };
  await pass.update(reconnected);
  expect(mocks.command).toHaveBeenCalledTimes(2);
  expect(mocks.query).toHaveBeenCalledTimes(1);
  expect(reconnected.onResult).toHaveBeenCalledTimes(106);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
