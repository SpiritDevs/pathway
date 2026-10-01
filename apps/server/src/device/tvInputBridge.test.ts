import * as NodeEvents from "node:events";
import * as NodeVM from "node:vm";
import { afterEach, expect, it, vi } from "vite-plus/test";
import { tvInputBridgeSource } from "./tvInputBridge.ts";

class Child extends NodeEvents.EventEmitter {
  readonly stdout = new NodeEvents.EventEmitter();
  readonly stderr = new NodeEvents.EventEmitter();
  readonly stdin = Object.assign(new NodeEvents.EventEmitter(), { write: vi.fn(), end: vi.fn() });
  readonly kill = vi.fn();
  reply(id: string, ok = true) {
    this.stdout.emit("data", JSON.stringify({ id, ok, error: "native failed" }) + "\n");
  }
}
function fixture() {
  const children: Child[] = [];
  const spawn = vi.fn(() => {
    const child = new Child();
    children.push(child);
    return child;
  });
  const context = NodeVM.createContext({
    spawn,
    fileURLToPath: String,
    URL,
    setTimeout,
    clearTimeout,
  });
  const script = tvInputBridgeSource
    .replace(/^import.*\n/gm, "")
    .replace("export function", "function")
    .replace("import.meta.url", '"file:///hub/vendor/serve-sim/dist/pathway-tv-input.mjs"');
  const input = NodeVM.runInContext(script + '\ncreatePathwayTvInput("remote-tv")', context) as {
    send: (button: string) => Promise<void>;
    close: () => void;
  };
  return { input, children, spawn };
}
afterEach(() => vi.useRealTimers());

it("shares one selected-host helper and resolves only matching acknowledgements", async () => {
  const { input, children, spawn } = fixture();
  try {
    const first = input.send("down"),
      second = input.send("select");
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0]).toEqual([
      "file:///hub/vendor/serve-sim/dist/native/pathway-tv-input",
      ["remote-tv"],
      { stdio: ["pipe", "pipe", "pipe"] },
    ]);
    const child = children[0]!;
    expect(child.stdin.write.mock.calls.map(([line]) => JSON.parse(line as string))).toEqual([
      { id: "1", button: "down" },
      { id: "2", button: "select" },
    ]);
    child.reply("unrelated");
    child.reply("1");
    await first;
    const rejected = expect(second).rejects.toThrow("native failed");
    child.reply("2", false);
    await rejected;
  } finally {
    input.close();
  }
  expect(children[0]!.kill).toHaveBeenCalledOnce();
});

it("fails pending requests on exit and starts a new helper for the next press", async () => {
  const { input, children } = fixture();
  const first = expect(input.send("home")).rejects.toThrow("TV input helper exited");
  children[0]!.emit("exit", 4);
  await first;
  const next = input.send("up");
  expect(children).toHaveLength(2);
  children[1]!.reply("2");
  await next;
  input.close();
  await expect(input.send("up")).rejects.toThrow("closed");
});

it("bounds the queue and cancels its own child on acknowledgement timeout", async () => {
  vi.useFakeTimers();
  const { input, children } = fixture();
  const requests = Array.from({ length: 64 }, () =>
    expect(input.send("right")).rejects.toThrow("timed out"),
  );
  await expect(input.send("right")).rejects.toThrow("queue is full");
  await vi.advanceTimersByTimeAsync(8000);
  await Promise.all(requests);
  expect(children[0]!.kill).toHaveBeenCalledOnce();
  input.close();
});

it("rejects unknown buttons without spawning and cancels in-flight work on session close", async () => {
  const { input, children, spawn } = fixture();
  await expect(input.send("tap")).rejects.toThrow("Unsupported TV button");
  expect(spawn).not.toHaveBeenCalled();
  const pending = expect(input.send("back")).rejects.toThrow("session closed");
  input.close();
  await pending;
  expect(children[0]!.stdin.end).toHaveBeenCalledOnce();
});
