import { describe, expect, it } from "vite-plus/test";
import * as NodeVM from "node:vm";
import { patchDeviceHubControlSource } from "./deviceHubControlAdapter.ts";

// The vendor handlers fire HID promises without awaiting them. Exercise that
// boundary with a deferred native call, including the original minified names.
const source = `class Helper {
  async handleHidMessage($,U){let J=$[0],Q=$.subarray(1),_=()=>JSON.parse(Q.toString());switch(J){case 3:{let W=_();this.hid.touch(W.type,W.x,W.y);break}case 6:{let W=_();this.hid.key(W.type,W.usage);break}case 13:this.softwareKeyboardSync=this.setSoftwareKeyboardVisible(true);break}}
  queueHingeControl($){}
  async setSoftwareKeyboardVisible($){this.hid.softwareKeyboard()}
  recordTouchEvent($){}
}; Helper`;
describe("pinned iOS HID receipt adapter", () => {
  it("acknowledges only after native completion and serializes the next packet", async () => {
    const Helper = NodeVM.runInNewContext(patchDeviceHubControlSource(source), { Buffer });
    const helper = new Helper();
    const calls: string[] = [];
    let complete!: () => void;
    const native = new Promise<void>((resolve) => {
      complete = resolve;
    });
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    helper.hid = {
      touch: () => {
        calls.push("touch");
        entered();
        return native;
      },
      key: () => {
        calls.push("key");
      },
    };
    const receipts: number[] = [];
    const socket = {
      send: (data: Buffer) => receipts.push(JSON.parse(data.subarray(1).toString()).id),
    };
    const packet = (id: number, tag: number, value: object) =>
      Buffer.concat([
        Buffer.from([126]),
        Buffer.from(
          JSON.stringify({
            id,
            packet: Buffer.concat([
              Buffer.from([tag]),
              Buffer.from(JSON.stringify(value)),
            ]).toString("base64"),
          }),
        ),
      ]);
    const first = helper.handleHidMessage(packet(1, 3, { type: "begin", x: 0.1, y: 0.2 }), socket);
    const second = helper.handleHidMessage(packet(2, 6, { type: "down", usage: 42 }), socket);
    await started;
    expect(calls).toEqual(["touch"]);
    expect(receipts).toEqual([]);
    complete();
    await Promise.all([first, second]);
    expect(calls).toEqual(["touch", "key"]);
    expect(receipts).toEqual([1, 2]);
  });
  it("rejects an unrecognized upstream version", () => {
    expect(() => patchDeviceHubControlSource("different vendor implementation")).toThrow(
      "Unsupported",
    );
  });
  it("waits for native input inside the software keyboard queue", async () => {
    const Helper = NodeVM.runInNewContext(patchDeviceHubControlSource(source), { Buffer });
    const helper = new Helper();
    const started = Promise.withResolvers<void>();
    const done = Promise.withResolvers<void>();
    helper.hid = {
      softwareKeyboard: () => {
        started.resolve();
        return done.promise;
      },
    };
    let acknowledged = false;
    const input = Buffer.concat([
      Buffer.from([126]),
      Buffer.from(
        JSON.stringify({
          id: 1,
          packet: Buffer.from([13]).toString("base64"),
        }),
      ),
    ]);
    const task = helper.handleHidMessage(input, {
      send: () => {
        acknowledged = true;
      },
    });
    await started.promise;
    expect(acknowledged).toBe(false);
    done.resolve();
    await task;
    expect(acknowledged).toBe(true);
  });
});
