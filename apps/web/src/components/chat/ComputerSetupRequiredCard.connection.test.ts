// The connected setup card's status read belongs to the connection that
// asked: an answer landing after that connection dropped must not overwrite
// the next connection's status. The component runs as a plain function with
// its hooks stubbed; the store and its fence are real.

import { EnvironmentId, type ComputerStatusResult } from "@spiritdevs/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const harness = vi.hoisted(() => ({ refreshStatus: vi.fn() }));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T>(callback: T) => callback,
  useEffect: (effect: () => void) => effect(),
  useState: <T>(initial: T) => [initial, () => undefined],
}));
vi.mock("@tanstack/react-router", () => ({ useNavigate: () => () => undefined }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => harness.refreshStatus }));
vi.mock("~/state/computer", () => ({ computerEnvironment: { refreshStatus: {} } }));
vi.mock("~/hooks/useComputerStatusRefresh", () => ({ useComputerStatusRefresh: () => undefined }));
vi.mock("~/hooks/useProvisionComputer", () => ({
  useProvisionComputer: () => ({ isPending: false, provision: () => undefined }),
}));
vi.mock("~/computerStateStore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/computerStateStore")>()),
  // No status cached yet, so the card asks once on mount.
  useCachedComputerStatus: () => undefined,
}));

const { useComputerStateStore } = await import("~/computerStateStore");
const { ConnectedComputerSetupRequiredCard } = await import("./ComputerSetupRequiredCard");

const ENV = EnvironmentId.make("environment-1");
const STATUS = { availability: { kind: "available" } } as ComputerStatusResult;

/** A promise the test settles by hand. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

afterEach(() => {
  harness.refreshStatus.mockReset();
  useComputerStateStore.getState().clearEnvironment(ENV);
});

describe("ConnectedComputerSetupRequiredCard", () => {
  it("stores its status answer on the connection that asked", async () => {
    const answer = deferred<unknown>();
    harness.refreshStatus.mockReturnValue(answer.promise);
    ConnectedComputerSetupRequiredCard({ environmentId: ENV });
    answer.resolve({ _tag: "Success", value: STATUS });
    await answer.promise;
    expect(useComputerStateStore.getState().statusByEnvironment[ENV]).toBe(STATUS);
  });

  it("drops a status answer that lands after the connection dropped", async () => {
    const answer = deferred<unknown>();
    harness.refreshStatus.mockReturnValue(answer.promise);
    ConnectedComputerSetupRequiredCard({ environmentId: ENV });
    expect(harness.refreshStatus).toHaveBeenCalledTimes(1);
    useComputerStateStore.getState().rebaseEnvironment(ENV);
    answer.resolve({ _tag: "Success", value: STATUS });
    await answer.promise;
    expect(useComputerStateStore.getState().statusByEnvironment[ENV]).toBeUndefined();
  });
});
