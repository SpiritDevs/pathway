import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  client: {
    start: vi.fn(),
    stop: vi.fn(),
    rotate: vi.fn(),
    pressButton: vi.fn(),
    setMjpegImage: vi.fn(),
    sendTouch: vi.fn(),
    sendKey: vi.fn(),
  },
  create: vi.fn(),
}));
vi.mock("../../../packages/client-runtime/src/device/stream.ts", () => ({
  createDeviceStreamClient: fixture.create,
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

const access = {
  httpBase: "https://env.example/api/device-hub",
  wsBase: "wss://env.example/api/device-hub",
  query: { wsTicket: "ticket", hostId: "local" },
  credentials: false,
  expiresAt: 1,
};

interface FakeElement {
  handlers: Record<string, (event: unknown) => void>;
  captured: Set<number>;
  releasePointerCapture: ReturnType<typeof vi.fn>;
}

function element(): FakeElement & Record<string, unknown> {
  const fake = {
    style: {},
    handlers: {} as FakeElement["handlers"],
    captured: new Set<number>(),
    setAttribute: vi.fn(),
    append: vi.fn(),
    focus: vi.fn(),
    addEventListener: (name: string, handler: (event: unknown) => void) => {
      fake.handlers[name] = handler;
    },
    setPointerCapture: (id: number) => fake.captured.add(id),
    hasPointerCapture: (id: number) => fake.captured.has(id),
    releasePointerCapture: vi.fn((id: number) => {
      fake.captured.delete(id);
      fake.handlers.lostpointercapture?.({ pointerId: id });
    }),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 100, height: 200 }),
  };
  return fake;
}

async function loadPage() {
  const postMessage = vi.fn();
  const windowStub: Record<string, unknown> = {
    webkit: { messageHandlers: { deviceStream: { postMessage } } },
    addEventListener: vi.fn(),
  };
  vi.stubGlobal("window", windowStub);
  const elements: FakeElement[] = [];
  vi.stubGlobal("document", {
    createElement: vi.fn(() => {
      const fake = element();
      elements.push(fake);
      return fake;
    }),
    body: { replaceChildren: vi.fn() },
  });
  let events: { onUnauthorized: () => void; onInputConnected: (connected: boolean) => void };
  fixture.create.mockImplementation((_target, _canvas, handlers) => {
    events = handlers;
    return fixture.client;
  });
  const page = await import("./entry.ts");
  const frame = () => elements.find((fake) => fake.handlers.pointerdown)!;
  return { page, postMessage, events: () => events, frame };
}

describe("native device stream page", () => {
  it("starts the shared client with the native ticket and forwards events", async () => {
    const { page, postMessage, events } = await loadPage();
    page.start({ platform: "ios", deviceId: "UDID", access, inputEnabled: false, control: null });
    expect(fixture.create).toHaveBeenCalledWith(
      { platform: "ios", deviceId: "UDID", access },
      expect.anything(),
      expect.anything(),
    );
    expect(fixture.client.start).toHaveBeenCalledOnce();
    events().onInputConnected(true);
    events().onUnauthorized();
    expect(postMessage.mock.calls.map(([message]) => message)).toEqual([
      { type: "input", connected: false },
      { type: "input", connected: true },
      { type: "unauthorized" },
    ]);
  });

  it("puts the control proof on the stream's URLs", async () => {
    const { page } = await loadPage();
    page.start({
      platform: "ios",
      deviceId: "UDID",
      access: { ...access, query: { ...access.query, viewerId: "old", controlGeneration: "1" } },
      inputEnabled: true,
      control: { viewerId: "viewer", generation: 7 },
    });
    expect(fixture.create.mock.calls[0]?.[0].access.query).toEqual({
      wsTicket: "ticket",
      hostId: "local",
      viewerId: "viewer",
      controlGeneration: "7",
    });
  });

  it("only sends hardware buttons while the user has control", async () => {
    const { page } = await loadPage();
    page.start({
      platform: "android",
      deviceId: "emulator-5554",
      access,
      inputEnabled: false,
      control: null,
    });
    page.command("home");
    expect(fixture.client.pressButton).not.toHaveBeenCalled();
    page.setInputEnabled(true);
    page.command("back");
    page.command("rotate");
    expect(fixture.client.pressButton).toHaveBeenCalledWith("back");
    expect(fixture.client.rotate).toHaveBeenCalledOnce();
    page.stop();
    expect(fixture.client.stop).toHaveBeenCalledOnce();
  });

  it("ends the active touch and lifts held keys when control is taken away", async () => {
    const { page, events, frame } = await loadPage();
    page.start({
      platform: "android",
      deviceId: "emulator-5554",
      access,
      inputEnabled: true,
      control: null,
    });
    events().onInputConnected(true);
    const pointer = { pointerId: 1, clientX: 25, clientY: 50, preventDefault: vi.fn() };
    frame().handlers.pointerdown!(pointer);
    const key = { code: "KeyA", key: "a", preventDefault: vi.fn() };
    frame().handlers.keydown!(key);

    page.setInputEnabled(false);
    frame().handlers.pointermove!({ ...pointer, clientX: 75, clientY: 150 });
    frame().handlers.pointerup!({ ...pointer, clientX: 75, clientY: 150 });
    frame().handlers.keyup!(key);

    expect(fixture.client.sendTouch.mock.calls).toEqual([
      ["begin", 0.25, 0.25],
      ["end", 0.25, 0.25],
    ]);
    expect(frame().releasePointerCapture).toHaveBeenCalledWith(1);
    expect(frame().captured.size).toBe(0);
    expect(fixture.client.sendKey.mock.calls).toEqual([
      [key, "down"],
      [key, "up"],
    ]);

    // A new gesture needs control again.
    frame().handlers.pointerdown!({ ...pointer, pointerId: 2 });
    expect(fixture.client.sendTouch).toHaveBeenCalledTimes(2);
    page.setInputEnabled(true);
    frame().handlers.pointerdown!({ ...pointer, pointerId: 2 });
    expect(fixture.client.sendTouch).toHaveBeenLastCalledWith("begin", 0.25, 0.25);
  });

  it("ends the active touch when the stream stops", async () => {
    const { page, events, frame } = await loadPage();
    page.start({ platform: "ios", deviceId: "UDID", access, inputEnabled: true, control: null });
    events().onInputConnected(true);
    frame().handlers.pointerdown!({
      pointerId: 1,
      clientX: 50,
      clientY: 100,
      preventDefault: vi.fn(),
    });
    page.stop();
    expect(fixture.client.sendTouch).toHaveBeenLastCalledWith("end", 0.5, 0.5);
    expect(fixture.client.stop).toHaveBeenCalledOnce();
  });

  it("rotates a portrait iOS framebuffer that reports landscape", async () => {
    const { page } = await loadPage();
    expect(
      page.deviceLayout("ios", { width: 390, height: 844, orientation: "landscape_left" }),
    ).toEqual({ aspect: 844 / 390, rotation: 90 });
    expect(
      page.deviceLayout("android", { width: 1080, height: 2400, orientation: "portrait" }),
    ).toEqual({ aspect: 1080 / 2400, rotation: 0 });
  });
});
