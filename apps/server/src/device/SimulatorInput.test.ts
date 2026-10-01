// @effect-diagnostics preferSchemaOverJson:off - JSON represents the external helper fixture boundary.
import { expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { sendSimulatorInput } from "./SimulatorInput.ts";
import type { DeviceHostReady } from "./DeviceHost.ts";

class HelperSocket extends EventTarget {
  static instances: HelperSocket[] = [];
  static opened: (socket: HelperSocket) => void = () => {};
  binaryType = "";
  closed = false;
  sent: Uint8Array[] = [];
  readonly url: URL;
  constructor(url: URL) {
    super();
    this.url = url;
    HelperSocket.instances.push(this);
    queueMicrotask(() => {
      this.dispatchEvent(new Event("open"));
      HelperSocket.opened(this);
    });
  }
  send(data: Uint8Array) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  reply(value: object) {
    const frame = Buffer.concat([Buffer.from([254]), Buffer.from(JSON.stringify(value))]);
    this.dispatchEvent(new MessageEvent("message", { data: Uint8Array.from(frame).buffer }));
  }
}
const ready: DeviceHostReady = {
  nodePath: "/node",
  hub: { origin: "http://ssh-forward.test:40123" },
  helpers: { serveSimAxSettings: null, serveSimCli: null },
  run: () => Effect.die("unused"),
};
afterEach(() => {
  vi.unstubAllGlobals();
  HelperSocket.instances = [];
});

it.effect("uses the selected host's forwarded origin and waits for native acknowledgement", () =>
  Effect.gen(function* () {
    vi.stubGlobal("WebSocket", HelperSocket);
    const connection = new Promise<HelperSocket>((resolve) => {
      HelperSocket.opened = resolve;
    });
    let done = false;
    const pending = yield* sendSimulatorInput(ready, "watch id", {
      kind: "digitalCrown",
      delta: 5,
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          done = true;
        }),
      ),
      Effect.forkChild,
    );
    const socket = yield* Effect.promise(() => connection);
    expect(socket.url.origin).toBe("ws://ssh-forward.test:40123");
    expect(socket.url.searchParams.get("device")).toBe("watch id");
    expect(done).toBe(false);
    expect(socket.sent[0]?.[0]).toBe(126);
    expect(JSON.parse(Buffer.from(socket.sent[0]!).subarray(1).toString())).toEqual({
      id: 1,
      packet: Buffer.concat([
        Buffer.from([10]),
        Buffer.from(JSON.stringify({ delta: 5 })),
      ]).toString("base64"),
    });
    socket.reply({ id: 2, ok: true });
    expect(done).toBe(false);
    socket.reply({ id: 1, ok: true });
    yield* Fiber.join(pending);
    expect(socket.closed).toBe(true);
  }),
);

it.effect("surfaces helper failures and early closes instead of reporting input success", () =>
  Effect.gen(function* () {
    vi.stubGlobal("WebSocket", HelperSocket);
    for (const mode of ["error", "close", "native"] as const) {
      HelperSocket.opened = (socket) => {
        if (mode === "native") socket.reply({ id: 1, ok: false, error: "HID unavailable" });
        else socket.dispatchEvent(new Event(mode));
      };
      const error = yield* sendSimulatorInput(ready, "tv", {
        kind: "remoteButton",
        button: "home",
      }).pipe(Effect.flip);
      expect(error._tag).toBe("DeviceOperationError");
      expect(HelperSocket.instances.at(-1)?.closed).toBe(true);
    }
  }),
);

it.effect("closes the helper socket when the caller is interrupted", () =>
  Effect.gen(function* () {
    vi.stubGlobal("WebSocket", HelperSocket);
    const connection = new Promise<HelperSocket>((resolve) => {
      HelperSocket.opened = resolve;
    });
    const pending = yield* sendSimulatorInput(ready, "watch", {
      kind: "digitalCrown",
      delta: 1,
    }).pipe(Effect.forkChild);
    const socket = yield* Effect.promise(() => connection);
    yield* Fiber.interrupt(pending);
    expect(socket.closed).toBe(true);
    const sent = socket.sent.length;
    socket.dispatchEvent(new Event("open"));
    expect(socket.sent).toHaveLength(sent);
  }),
);
