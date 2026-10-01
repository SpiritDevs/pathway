import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  client: {
    start: vi.fn(),
    stop: vi.fn(),
    rotate: vi.fn(),
    pressButton: vi.fn(),
    setMjpegImage: vi.fn(),
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

const element = () => ({
  style: {},
  setAttribute: vi.fn(),
  append: vi.fn(),
  addEventListener: vi.fn(),
});

async function loadPage() {
  const postMessage = vi.fn();
  const windowStub: Record<string, unknown> = {
    webkit: { messageHandlers: { deviceStream: { postMessage } } },
    addEventListener: vi.fn(),
  };
  vi.stubGlobal("window", windowStub);
  vi.stubGlobal("document", {
    createElement: vi.fn(element),
    body: { replaceChildren: vi.fn() },
  });
  let events: { onUnauthorized: () => void; onInputConnected: (connected: boolean) => void };
  fixture.create.mockImplementation((_target, _canvas, handlers) => {
    events = handlers;
    return fixture.client;
  });
  const page = await import("./entry.ts");
  return { page, postMessage, events: () => events };
}

describe("native device stream page", () => {
  it("starts the shared client with the native ticket and forwards events", async () => {
    const { page, postMessage, events } = await loadPage();
    page.start({ platform: "ios", deviceId: "UDID", access, inputEnabled: false });
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

  it("only sends hardware buttons while the user has control", async () => {
    const { page } = await loadPage();
    page.start({ platform: "android", deviceId: "emulator-5554", access, inputEnabled: false });
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
