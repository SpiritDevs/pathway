import { EnvironmentId, type DeviceSummary } from "@spiritdevs/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type Result = { _tag: "Success"; value: unknown } | { _tag: "Failure"; cause: unknown };
const { action } = vi.hoisted(() => ({ action: vi.fn<(request: unknown) => Promise<Result>>() }));
vi.mock("~/state/device", () => ({ deviceEnvironment: { action: "action" } }));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => action }));
vi.mock("~/state/query", () => ({ formatEnvironmentQueryError: () => "Pairing failed" }));
// Base UI popups need a DOM; the pairing select only has to report its value here.
vi.mock("~/components/ui/select", () => ({
  Select: (props: { children: unknown }) => props.children,
  SelectTrigger: (props: { children: unknown }) => props.children,
  SelectValue: (props: { children: unknown }) => props.children,
  SelectPopup: () => null,
  SelectItem: () => null,
}));
import { DeviceTvRemote } from "./DeviceTvRemote";
import { CROWN_STEP, DeviceWatchControls } from "./DeviceWatchControls";
import { DeviceWatchPairing } from "./DeviceWatchPairing";
import type { DeviceInputControls } from "./useDeviceInput";

const environmentId = EnvironmentId.make("environment");
const base = {
  hostId: "local",
  platform: "ios",
  version: "27.0",
  booted: true,
  physical: false,
} as const;
const phone: DeviceSummary = { ...base, id: "phone", name: "iPhone 18 Pro", family: "phone" };
const watch: DeviceSummary = { ...base, id: "watch", name: "Apple Watch", family: "watch" };

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  action.mockReset();
  action.mockResolvedValue({ _tag: "Success", value: {} });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function input(enabled = true): DeviceInputControls {
  return {
    enabled,
    error: null,
    clearError: () => {},
    queue: { press: vi.fn(), turnCrown: vi.fn(), cancel: vi.fn() },
  };
}
const button = (label: string) => renderer!.root.findByProps({ "aria-label": label });

it("Watch rail turns and presses the Crown, presses the side button, and takes wheel and arrows", async () => {
  const controls = input();
  await act(async () => {
    renderer = create(<DeviceWatchControls input={controls} />);
  });
  await act(async () => button("Turn Digital Crown up").props.onClick());
  await act(async () => button("Press Digital Crown").props.onClick());
  await act(async () => button("Press side button").props.onClick());
  const rail = renderer!.root.findByProps({ role: "group" });
  rail.props.onWheel({ deltaY: 3, deltaMode: 1, ctrlKey: false });
  rail.props.onWheel({ deltaY: 3, deltaMode: 0, ctrlKey: true });
  const preventDefault = vi.fn();
  rail.props.onKeyDown({ key: "ArrowDown", target: 1, currentTarget: 1, preventDefault });
  expect(controls.queue.turnCrown).toHaveBeenNthCalledWith(1, -CROWN_STEP);
  expect(controls.queue.turnCrown).toHaveBeenNthCalledWith(2, 48);
  expect(controls.queue.turnCrown).toHaveBeenNthCalledWith(3, CROWN_STEP);
  expect(controls.queue.turnCrown).toHaveBeenCalledTimes(3);
  expect(preventDefault).toHaveBeenCalled();
  expect(controls.queue.press).toHaveBeenCalledWith({ kind: "watchButton", button: "crown" });
  expect(controls.queue.press).toHaveBeenCalledWith({ kind: "watchButton", button: "side" });
});

it("disables Watch and TV controls without input", async () => {
  await act(async () => {
    renderer = create(
      <>
        <DeviceWatchControls input={input(false)} />
        <DeviceTvRemote input={input(false)} />
      </>,
    );
  });
  expect(button("Press side button").props.disabled).toBe(true);
  expect(button("Select").props.disabled).toBe(true);
  expect(button("TV / Home").props.disabled).toBe(true);
});

it("Siri Remote sends focus-engine buttons", async () => {
  const controls = input();
  await act(async () => {
    renderer = create(<DeviceTvRemote input={controls} />);
  });
  for (const label of ["Up", "Left", "Select", "Right", "Down", "Back", "TV / Home", "Play/Pause"])
    await act(async () => button(label).props.onClick());
  expect(vi.mocked(controls.queue.press).mock.calls.map(([press]) => press)).toEqual(
    ["up", "left", "select", "right", "down", "back", "home", "playPause"].map((name) => ({
      kind: "remoteButton",
      button: name,
    })),
  );
});

it("pairs an unpaired Watch with the chosen iPhone and unpairs a paired one", async () => {
  const devices = [phone, { ...watch, watchPair: null }];
  await act(async () => {
    renderer = create(
      <DeviceWatchPairing environmentId={environmentId} watch={devices[1]!} devices={devices} />,
    );
  });
  expect(JSON.stringify(renderer!.toJSON())).toContain("Not paired");
  await act(async () => button("Pair Apple Watch with iPhone 18 Pro").props.onClick());
  expect(action).toHaveBeenLastCalledWith({
    environmentId,
    input: { hostId: "local", deviceId: "watch", type: "pairWatch", phoneDeviceId: "phone" },
  });

  const paired = {
    ...watch,
    watchPair: { pairId: "pair", phoneDeviceId: "phone", state: "(active, connected)" },
  };
  action.mockResolvedValueOnce({ _tag: "Failure", cause: "busy" });
  await act(async () =>
    renderer!.update(
      <DeviceWatchPairing environmentId={environmentId} watch={paired} devices={[phone, paired]} />,
    ),
  );
  await act(async () => button("Unpair Apple Watch").props.onClick());
  expect(action).toHaveBeenLastCalledWith({
    environmentId,
    input: { hostId: "local", deviceId: "watch", type: "unpairWatch" },
  });
  expect(renderer!.root.findByProps({ role: "alert" }).children).toEqual(["Pairing failed"]);
});

it("explains when the server cannot report pairing", async () => {
  await act(async () => {
    renderer = create(
      <DeviceWatchPairing environmentId={environmentId} watch={watch} devices={[phone, watch]} />,
    );
  });
  expect(renderer!.root.findByType("p").children.join("")).toContain("newer Pathway server");
  expect(renderer!.root.findAllByType("button")).toHaveLength(0);
});
