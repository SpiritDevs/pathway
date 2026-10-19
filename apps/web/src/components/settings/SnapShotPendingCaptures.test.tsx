import type { DesktopPendingSnapShot } from "@spiritdevs/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const effects = vi.hoisted(() => [] as (() => void)[]);
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useState: reactHookHarness.useState,
    useEffect: (effect: () => void) => effects.push(effect),
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
const bridge = vi.hoisted(() => ({
  listPendingSnapShots: vi.fn<() => Promise<ReadonlyArray<DesktopPendingSnapShot>>>(),
  acknowledgeSnapShot: vi.fn(),
  onSnapShotEvent: vi.fn(() => () => undefined),
}));
const toastManager = vi.hoisted(() => ({ add: vi.fn() }));
vi.mock("../../lib/snapShotAccount", () => ({ useSnapShotAccountId: () => "test-user" }));
vi.mock("../../lib/desktopSnapShot", () => ({ getDesktopSnapShotBridge: () => bridge }));
vi.mock("../ui/toast", () => ({ toastManager }));
import { SnapShotPendingCaptures } from "./SnapShotPendingCaptures";

const capture: DesktopPendingSnapShot = {
  id: "12345678-1234-1234-1234-123456789abc",
  name: "window.png",
  mimeType: "image/png",
  sizeBytes: 3,
  source: {
    kind: "snap-shot",
    capturedAt: "2026-09-01T00:00:00.000Z",
    appName: "Editor",
    windowTitle: "main.ts",
  },
};
function render() {
  hooks.beginRender();
  return SnapShotPendingCaptures();
}
async function mount() {
  render();
  for (const effect of effects.splice(0)) effect();
  await bridge.listPendingSnapShots.mock.results[0]!.value;
  return render();
}
function discard(tree: ReturnType<typeof render>) {
  const button = visitElements(
    tree,
    (element) => element.props["aria-label"] === "Discard capture from Editor",
  );
  if (!button) throw new Error("Missing discard button");
  (button.props as { onClick: () => void }).onClick();
}
beforeEach(() => {
  hooks.reset();
  effects.length = 0;
  vi.clearAllMocks();
  bridge.listPendingSnapShots.mockResolvedValue([capture]);
  bridge.acknowledgeSnapShot.mockReset().mockResolvedValue(undefined);
  vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());
it("discards only the selected pending capture and refreshes the queue", async () => {
  const tree = await mount();
  bridge.listPendingSnapShots.mockResolvedValue([]);
  discard(tree);
  await bridge.acknowledgeSnapShot.mock.results[0]!.value;
  await Promise.resolve();
  expect(bridge.acknowledgeSnapShot).toHaveBeenCalledExactlyOnceWith(capture.id);
  expect(render()).toBeNull();
});
it("keeps a capture visible when discard fails", async () => {
  const tree = await mount();
  bridge.acknowledgeSnapShot.mockRejectedValueOnce(new Error("desktop disconnected"));
  discard(tree);
  await bridge.acknowledgeSnapShot.mock.results[0]!.value.catch(() => undefined);
  expect(render()).not.toBeNull();
  expect(toastManager.add).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Couldn't discard the saved capture" }),
  );
});
