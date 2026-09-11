import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { AsyncResult } from "effect/unstable/reactivity";
import { ThreadId } from "@spiritdevs/contracts";
import { makeThreadFixture } from "../test-fixtures";
import { useSidebarPrRevalidation } from "./sidebarPrRevalidation";

const mocks = vi.hoisted(() => ({
  command: vi.fn(),
  query: vi.fn(),
  effects: [] as Array<() => void | (() => void)>,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useContext: () => ({}),
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => void | (() => void)) => {
    mocks.effects.push(effect);
  },
}));
vi.mock("@spiritdevs/client-runtime/state/runtime", async (original) => ({
  ...(await original<typeof import("@spiritdevs/client-runtime/state/runtime")>()),
  runAtomCommand: mocks.command,
  executeAtomQuery: mocks.query,
}));
vi.mock("./vcs", () => ({ vcsEnvironment: { refreshStatus: "refresh-status" } }));
vi.mock("./pullRequests", () => ({
  pullRequestEnvironment: { invalidate: "invalidate", detail: vi.fn() },
}));

const thread = makeThreadFixture({ branch: "work", worktreePath: "/work" });
let cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.effects.length = 0;
});
afterEach(() => {
  cleanup.forEach((stop) => stop());
  cleanup = [];
});
function mount(threads = [thread], onResult = vi.fn()) {
  useSidebarPrRevalidation("account/company", threads, [], onResult);
  cleanup = mocks.effects.map((effect) => effect()).filter((stop): stop is () => void => !!stop);
  return onResult;
}

it("rechecks a retained branch and reports the new open PR without mounting its row", async () => {
  mocks.command.mockResolvedValue(
    AsyncResult.success({
      refName: "work",
      pr: { state: "open", url: "https://github.com/example/repo/pull/2" },
    }),
  );
  const completed = deferred<void>();
  const onResult = vi.fn(() => completed.resolve());
  mount([thread], onResult);
  await completed.promise;
  expect(mocks.command.mock.calls[0]?.[1]).toBe("refresh-status");
  expect(onResult.mock.calls[0]).toEqual([
    expect.any(String),
    expect.objectContaining({ state: "open" }),
    false,
  ]);
});

it("bounds remount work and stops queued history reads when the sidebar leaves", async () => {
  const pending = Array.from({ length: 4 }, () => deferred<unknown>());
  mocks.command.mockImplementation(() => pending[mocks.command.mock.calls.length - 1]!.promise);
  const onResult = mount(
    Array.from({ length: 106 }, (_, index) => ({
      ...thread,
      id: ThreadId.make(`history-${index}`),
    })),
  );
  expect(mocks.command).toHaveBeenCalledTimes(4);
  cleanup.forEach((stop) => stop());
  for (const entry of pending) entry.resolve(AsyncResult.success({ refName: "work", pr: null }));
  await Promise.all(pending.map((entry) => entry.promise));
  expect(onResult).not.toHaveBeenCalled();
  expect(mocks.command).toHaveBeenCalledTimes(4);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
