import * as NodeVM from "node:vm";
import { expect, it, vi } from "vite-plus/test";
import { simulatorInputBoundarySource } from "./simulatorInputBoundary.ts";

function fixture(family: "watch" | "tv" | "phone" = "watch") {
  const calls: unknown[][] = [];
  const native = Object.fromEntries(
    ["touch", "button", "buttonHid", "key", "digitalCrown", "multiTouch", "scroll"].map((name) => [
      name,
      async (...args: unknown[]) => {
        calls.push([name, ...args]);
      },
    ]),
  );
  const session = {
    udid: "target",
    family: "phone",
    phase: "running",
    width: 200,
    height: 250,
    hid: { handle: native },
    waitForCapture: async () => {},
  };
  const replies: { ok: boolean; error?: string }[] = [];
  const socket = {
    readyState: 1,
    send: (data: Buffer) => replies.push(JSON.parse(data.subarray(1).toString())),
  };
  const execFile = vi.fn(
    (
      _cmd: string,
      _args: string[],
      _options: unknown,
      callback: (error: null, value: string) => void,
    ) =>
      callback(
        null,
        JSON.stringify({
          devices: {
            [`com.apple.CoreSimulator.SimRuntime.${family === "tv" ? "tvOS" : family === "watch" ? "watchOS" : "iOS"}-27-0`]:
              [{ udid: "target", isAvailable: true }],
          },
        }),
      ),
  );
  const build = vi.fn(async () => {});
  const context = NodeVM.createContext({
    Buffer,
    execFile,
    ensurePathwayTvInput: build,
    createPathwayTvInput: () => ({
      send: async (button: string) => {
        calls.push(["tv", button]);
      },
    }),
  });
  const create = NodeVM.runInContext(
    simulatorInputBoundarySource.replace(/^import.*\n/gm, "").replaceAll("export ", "") +
      "\ncreatePathwaySimulatorInput",
    context,
  ) as (s: typeof session) => {
    handle: (data: Buffer, ws: typeof socket, legacy: () => Promise<void>) => Promise<void>;
    close: () => void;
  };
  const boundary = create(session);
  const legacy = vi.fn(async () => {});
  const send = (tag: number, payload: object, envelope = true, target = socket) =>
    boundary.handle(
      Buffer.concat([
        Buffer.from([envelope ? 18 : tag]),
        Buffer.from(JSON.stringify(envelope ? { id: "test", tag, payload } : payload)),
      ]),
      target,
      legacy,
    );
  return { calls, native, session, socket, replies, boundary, send, execFile, build, legacy };
}

it("uses host runtime metadata and blocks every TV digitizer path, including legacy clients", async () => {
  const f = fixture("tv");
  for (const envelope of [true, false])
    for (const [tag, payload] of [
      [3, { type: "begin", x: 0.5, y: 0.5 }],
      [4, { page: 12, usage: 64 }],
      [4, { button: "home" }],
      [10, { delta: 10 }],
      [6, { type: "down", usage: 40 }],
    ] as const)
      await f.send(tag, payload, envelope);
  expect(f.calls).toEqual([]);
  expect(f.legacy).not.toHaveBeenCalled();
  expect(f.replies.every((reply) => !reply.ok)).toBe(true);
  await f.send(19, { button: "select" });
  expect(f.calls).toEqual([["tv", "select"]]);
  expect(f.execFile).toHaveBeenCalledOnce();
  expect(f.execFile.mock.calls[0]?.slice(0, 2)).toEqual([
    "xcrun",
    ["simctl", "list", "devices", "--json"],
  ]);
});

it("validates Watch payloads on both wire formats before native dispatch", async () => {
  const f = fixture();
  for (const envelope of [true, false])
    for (const [tag, payload] of [
      [3, { type: "begin", x: 100, y: -50 }],
      [10, { delta: 1e100 }],
      [4, { page: 1, usage: 64 }],
      [4, { page: 12, usage: 64, phase: "down" }],
      [19, { button: "home" }],
    ] as const)
      await f.send(tag, payload, envelope);
  expect(f.calls).toEqual([]);
  expect(f.replies.every((reply) => !reply.ok)).toBe(true);
  await f.send(10, { delta: -20 }, false);
  await f.send(4, { page: 12, usage: 149 });
  expect(f.calls).toEqual([
    ["digitalCrown", -20],
    ["buttonHid", 12, 149, "press"],
  ]);
});

it("bounds the shared queue and serializes native completion across sockets", async () => {
  const f = fixture();
  let release!: () => void, started!: () => void;
  const begun = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.native.digitalCrown = async () => {
    f.calls.push(["start"]);
    started();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  };
  const first = f.send(10, { delta: 1 });
  await begun;
  const queued = Array.from({ length: 255 }, () => f.send(4, { page: 12, usage: 64 }));
  expect(f.calls).toEqual([["start"]]);
  release();
  await Promise.all([first, ...queued]);
  expect(f.calls).toHaveLength(64);
  expect(f.replies.filter((reply) => reply.error?.includes("queue is full"))).toHaveLength(192);
});

it("drops queued work after socket revocation and after session close", async () => {
  for (const closeSession of [false, true]) {
    const f = fixture();
    let release!: () => void, started!: () => void;
    const begun = new Promise<void>((resolve) => {
      started = resolve;
    });
    f.session.waitForCapture = () => {
      started();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    const pending = f.send(10, { delta: 1 });
    await begun;
    if (closeSession) f.boundary.close();
    else f.socket.readyState = 3;
    release();
    await pending;
    expect(f.calls).toEqual([]);
  }
});

it("preserves phone buttons and pairs key down/up even when native down fails", async () => {
  const f = fixture("phone");
  await f.send(4, { button: "app_switcher" }, false);
  f.native.key = async (...args) => {
    f.calls.push(["key", ...args]);
    if (args[0] === "down") throw Error("failed down");
  };
  await f.send(6, { usage: 40 });
  expect(f.calls).toEqual([
    ["button", "app_switcher"],
    ["key", "down", 40],
    ["key", "up", 40],
  ]);
  expect(f.replies.at(-1)?.ok).toBe(false);
});
