import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  surface: {
    input: { readOnly: false },
    write: vi.fn(),
    resetAndWrite: vi.fn(),
    getSelection: vi.fn(() => "selected text"),
    pasteFromClipboard: vi.fn(async (read: () => Promise<string>) => read()),
    focus: vi.fn(),
    dispose: vi.fn(),
  },
  create: vi.fn(),
}));
vi.mock("../../web/src/terminal/ghostty/surface", () => ({
  GhosttyTerminalSurface: { create: fixture.create },
}));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.resetModules();
});

describe("offline native terminal bridge", () => {
  it("gates writes, preserves raw VT output, dispatches paste/copy and disposes", async () => {
    const postMessage = vi.fn();
    let callbacks:
      | { onData: (text: string) => void; onResize: (cols: number, rows: number) => void }
      | undefined;
    fixture.create.mockImplementation(async (_mount, options) => {
      callbacks = options;
      return fixture.surface;
    });
    const windowStub: {
      webkit: { messageHandlers: { terminal: { postMessage: typeof postMessage } } };
      addEventListener: ReturnType<typeof vi.fn>;
      open?: () => null;
      pathwayTerminal?: {
        receive: (commands: readonly { kind: string; data?: string; enabled?: boolean }[]) => void;
        dispose: () => void;
      };
    } = { webkit: { messageHandlers: { terminal: { postMessage } } }, addEventListener: vi.fn() };
    vi.stubGlobal("window", windowStub);
    vi.stubGlobal("document", { getElementById: () => ({}) });
    await import("./entry");
    expect(postMessage).toHaveBeenCalledWith({ type: "ready" });
    callbacks?.onData("blocked input");
    expect(postMessage).not.toHaveBeenCalledWith({ type: "input", data: "blocked input" });
    windowStub.pathwayTerminal?.receive([
      { kind: "reset", data: "history\u001b[2J" },
      { kind: "write", data: "\u001b[31mred\u001b[0m" },
      { kind: "enabled", enabled: true },
      { kind: "copy" },
      { kind: "paste", data: "pasted text" },
    ]);
    expect(fixture.surface.resetAndWrite).toHaveBeenCalledWith("history\u001b[2J");
    expect(fixture.surface.write).toHaveBeenCalledWith("\u001b[31mred\u001b[0m");
    expect(fixture.surface.input.readOnly).toBe(false);
    expect(postMessage).toHaveBeenCalledWith({ type: "copy", data: "selected text" });
    expect(await fixture.surface.pasteFromClipboard.mock.results[0]?.value).toBe("pasted text");
    callbacks?.onData("typed input");
    callbacks?.onResize(100, 30);
    expect(postMessage).toHaveBeenCalledWith({ type: "input", data: "typed input" });
    expect(postMessage).toHaveBeenCalledWith({ type: "resize", cols: 100, rows: 30 });
    windowStub.pathwayTerminal?.dispose();
    callbacks?.onData("after dispose");
    expect(fixture.surface.dispose).toHaveBeenCalledOnce();
    expect(postMessage).not.toHaveBeenCalledWith({ type: "input", data: "after dispose" });
    expect(windowStub.open?.()).toBeNull();
  });
});
