import * as NodeVM from "node:vm";
import { patch } from "./deviceHubPatch.testkit.ts";
import { patchDeviceHubControlSource } from "./deviceHubControlAdapter.ts";

/** Executes both production patches; only process, transport and native calls are mocked. */
export function managedSimulator(entry = "middleware.js") {
  const install = patch();
  install.run();
  const calls: { device: string; method: string; args: unknown[] }[] = [];
  const receipts: Buffer[] = [];
  let beforeInput = async () => {};
  const invoke = async (device: string, method: string, args: unknown[]) => {
    calls.push({ device, method, args });
    await beforeInput();
  };
  const context = NodeVM.createContext({
    Buffer,
    execFile: (
      _command: string,
      _args: string[],
      _options: unknown,
      callback: (error: null, output: string) => void,
    ) =>
      callback(
        null,
        JSON.stringify({
          devices: {
            "com.apple.CoreSimulator.SimRuntime.watchOS-27-0": [
              { udid: "watch", isAvailable: true },
            ],
            "com.apple.CoreSimulator.SimRuntime.tvOS-27-0": [{ udid: "tv", isAvailable: true }],
            "com.apple.CoreSimulator.SimRuntime.iOS-27-0": [{ udid: "phone", isAvailable: true }],
          },
        }),
      ),
    ensurePathwayTvInput: async () => {},
    createPathwayTvInput: (device: string) => ({
      send: (button: string) => invoke(device, "remote", [button]),
    }),
  });
  NodeVM.runInContext(
    install.writes
      .get("/hub/vendor/serve-sim/dist/pathway-simulator-input.mjs")!
      .replace(/^import.*\n/gm, "")
      .replaceAll("export ", ""),
    context,
  );
  type Socket = { readyState: number; send: (data: Buffer) => void };
  type Helper = {
    udid: string;
    width: number;
    height: number;
    waitForCapture: () => Promise<void>;
    hid: { handle: Record<string, (...args: unknown[]) => Promise<void>> };
    handleHidMessage: (data: Buffer, socket: Socket) => Promise<void>;
  };
  const Constructor = NodeVM.runInContext(
    patchDeviceHubControlSource(install.writes.get(`/hub/vendor/serve-sim/dist/${entry}`)!).replace(
      /^import.*\n/gm,
      "",
    ) + "\nSession",
    context,
  ) as new () => Helper;
  const helpers = new Map<string, Helper>();
  const deliver = (device: string, packet: Uint8Array, send: (data: Buffer) => void) => {
    let helper = helpers.get(device);
    if (!helper) {
      helper = new Constructor();
      helper.udid = device;
      helper.width = 200;
      helper.height = 250;
      helper.waitForCapture = async () => {};
      helper.hid = {
        handle: Object.fromEntries(
          ["touch", "button", "buttonHid", "key", "digitalCrown"].map((method) => [
            method,
            (...args: unknown[]) => invoke(device, method, args),
          ]),
        ),
      };
      helpers.set(device, helper);
    }
    return helper.handleHidMessage(Buffer.from(packet), {
      readyState: 1,
      send: (data) => {
        receipts.push(data);
        send(data);
      },
    });
  };
  class WebSocket extends EventTarget {
    binaryType = "arraybuffer";
    readonly url: URL;
    constructor(url: URL) {
      super();
      this.url = url;
      queueMicrotask(() => this.dispatchEvent(new Event("open")));
    }
    send(packet: Uint8Array) {
      void deliver(this.url.searchParams.get("device")!, packet, (data) =>
        this.dispatchEvent(new MessageEvent("message", { data: Uint8Array.from(data).buffer })),
      ).catch(() => this.dispatchEvent(new Event("error")));
    }
    close() {}
  }
  return {
    calls,
    receipts,
    deliver,
    WebSocket,
    beforeInput: (callback: () => Promise<void>) => {
      beforeInput = callback;
    },
  };
}
