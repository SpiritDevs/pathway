import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { NativeDictationHost } from "../../../../apps/desktop/src/dictation/NativeDictationHost.ts";

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

class FakeChild extends NodeEvents.EventEmitter {
  readonly stdout = new NodeStream.PassThrough();
  readonly stderr = new NodeStream.PassThrough();
  readonly stdin = new NodeStream.PassThrough();
  readonly kill = vi.fn(() => true);
  readonly commands: Array<Record<string, unknown>> = [];
  constructor() {
    super();
    this.stdin.on("data", (data: Buffer) => {
      this.commands.push(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  }
  send(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }
  exit(code = 0) {
    this.emit("exit", code, null);
    this.emit("close", code, null);
  }
  ready() {
    this.send({ type: "ready", protocolVersion: 1, platform: "darwin", shortcuts: ["fn", "F8"] });
  }
}

let child: FakeChild;
let host: NativeDictationHost;
const events = vi.fn();
beforeEach(() => {
  vi.useFakeTimers();
  child = new FakeChild();
  mocks.spawn.mockReset();
  mocks.spawn.mockReturnValue(child);
  events.mockClear();
  host = new NativeDictationHost({ binaryPath: "/test/host", onEvent: events });
});
afterEach(() => {
  child.exit();
  vi.useRealTimers();
});

async function start() {
  const started = host.start();
  child.ready();
  await started;
}

describe("native dictation JSON-lines bridge", () => {
  it("starts once, handles chunked events and correlates out-of-order replies", async () => {
    await start();
    await host.start();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    const devices = host.request({ type: "enumerate" });
    const permissions = host.request({ type: "permissions" });
    await Promise.resolve();
    expect(child.commands).toHaveLength(2);
    child.send({
      requestId: 2,
      ok: true,
      result: { microphone: "unknown", accessibility: "denied", inputMonitoring: "denied" },
    });
    child.stdout.write('{"type":"shortcut-down","shortcut":"fn",');
    child.stdout.write('"timestampMs":123}\n');
    child.send({
      requestId: 1,
      ok: true,
      result: [{ id: "mic", name: "Microphone", isDefault: true }],
    });
    expect(await devices).toEqual([{ id: "mic", name: "Microphone", isDefault: true }]);
    expect((await permissions).microphone).toBe("unknown");
    expect(events).toHaveBeenCalledWith({
      type: "shortcut-down",
      shortcut: "fn",
      timestampMs: 123,
    });
  });

  it("forwards a selected permission without changing legacy requests", async () => {
    await start();
    const microphone = host.request({
      type: "permissions",
      request: true,
      permission: "microphone",
    });
    const accessibilityCheck = host.request({
      type: "permissions",
      request: false,
      permission: "accessibility",
    });
    const legacy = host.request({ type: "permissions", request: true });
    await Promise.resolve();
    expect(child.commands).toEqual([
      { requestId: 1, type: "permissions", request: true, permission: "microphone" },
      { requestId: 2, type: "permissions", request: false, permission: "accessibility" },
      { requestId: 3, type: "permissions", request: true },
    ]);
    for (const command of child.commands)
      child.send({
        requestId: command.requestId,
        ok: true,
        result: { microphone: "unknown", accessibility: "denied", inputMonitoring: "denied" },
      });
    await Promise.all([microphone, accessibilityCheck, legacy]);
  });

  it("reports an insertion timeout as unconfirmed without resending it", async () => {
    await start();
    const insertion = host.request({ type: "insert", text: "once" });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await insertion).toMatchObject({ status: "unconfirmed" });
    child.send({ requestId: 1, ok: true, result: { status: "inserted" } });
    expect(child.commands).toHaveLength(1);
  });

  it("treats an exited insertion worker as unconfirmed and rejects capture requests", async () => {
    await start();
    const insertion = host.request({ type: "insert", text: "once" });
    const capture = host.request({ type: "stopCapture", id: "take" });
    const failure = expect(capture).rejects.toThrow("exited");
    await Promise.resolve();
    child.exit(1);
    expect(await insertion).toMatchObject({ status: "unconfirmed" });
    await failure;
    expect(child.commands).toHaveLength(2);
  });

  it("closes stdin after a capture timeout so a late start cannot keep recording", async () => {
    await start();
    const capture = host.request({ type: "startCapture", id: "take", path: "/tmp/take.wav" });
    const failure = expect(capture).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(15_000);
    await failure;
    expect(child.stdin.writableEnded).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("serializes close and restart and ignores old-process replies and events", async () => {
    await start();
    const oldChild = child;
    const oldRequest = host.request({ type: "enumerate" });
    const oldFailure = expect(oldRequest).rejects.toThrow("exited");
    await Promise.resolve();
    const closing = host.close();
    expect(host.close()).toBe(closing);
    const nextChild = new FakeChild();
    mocks.spawn.mockReturnValue(nextChild);
    const nextRequest = host.request({ type: "permissions" });
    await Promise.resolve();
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    oldChild.send({ type: "shortcut-down", shortcut: "fn", timestampMs: 5 });
    expect(events).not.toHaveBeenCalledWith(expect.objectContaining({ type: "shortcut-down" }));
    oldChild.exit();
    await closing;
    await oldFailure;
    await Promise.resolve();
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    nextChild.ready();
    await Promise.resolve();
    await Promise.resolve();
    const command = nextChild.commands[0]!;
    expect(command.type).toBe("permissions");
    oldChild.send({
      requestId: command.requestId,
      ok: true,
      result: { microphone: "wrong process" },
    });
    oldChild.send({ type: "level", id: "old-account", durationMs: 10, level: 1 });
    nextChild.send({
      requestId: command.requestId,
      ok: true,
      result: { microphone: "unknown", accessibility: "denied", inputMonitoring: "denied" },
    });
    expect((await nextRequest).microphone).toBe("unknown");
    expect(events).not.toHaveBeenCalledWith(expect.objectContaining({ type: "level" }));
    child = nextChild;
  });

  it("turns an explicit insertion error into an unconfirmed result", async () => {
    await start();
    const insertion = host.request({ type: "insert", text: "once" });
    await Promise.resolve();
    child.send({ requestId: 1, ok: false, error: "The application timed out after dispatch" });
    expect(await insertion).toEqual({
      status: "unconfirmed",
      reason: "The application timed out after dispatch",
    });
    expect(child.commands).toHaveLength(1);
  });

  it("rejects protocol incompatibility before commands can run", async () => {
    const started = host.start();
    const failure = expect(started).rejects.toThrow("Unsupported");
    child.send({ type: "ready", protocolVersion: 2 });
    await failure;
    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.commands).toHaveLength(0);
  });

  it("cleans up once across error and exit callbacks and can restart", async () => {
    const first = host.start();
    const failure = expect(first).rejects.toThrow("missing");
    child.emit("error", new Error("missing"));
    await failure;
    const nextChild = new FakeChild();
    mocks.spawn.mockReturnValue(nextChild);
    const nextStart = host.start();
    nextChild.ready();
    await nextStart;
    const devices = host.request({ type: "enumerate" });
    await Promise.resolve();
    child.exit(1);
    nextChild.send({ requestId: 1, ok: true, result: [] });
    expect(await devices).toEqual([]);
    child = nextChild;
  });
});
