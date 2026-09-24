import { ComputerId, EnvironmentId } from "@spiritdevs/contracts";
import type { ComputerFrame } from "@spiritdevs/shared/computerFrame";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  COMPUTER_LIVE_VIEW_UNAVAILABLE,
  mergeComputerImageStreamStatus,
  useComputerImageStream,
} from "./useComputerImageStream";

describe("mergeComputerImageStreamStatus", () => {
  it("keeps the previous object when a frame reports streaming again", () => {
    const previous = { kind: "streaming" } as const;
    expect(mergeComputerImageStreamStatus(previous, { kind: "streaming" })).toBe(previous);
  });

  it("returns the next status when the kind changes", () => {
    const next = { kind: "streaming" } as const;
    expect(mergeComputerImageStreamStatus({ kind: "connecting" }, next)).toBe(next);
  });

  it("keeps the previous error while the message is unchanged, and swaps when it differs", () => {
    const previous = { kind: "error", message: "boom" } as const;
    expect(mergeComputerImageStreamStatus(previous, { kind: "error", message: "boom" })).toBe(
      previous,
    );

    const next = { kind: "error", message: "different" } as const;
    expect(mergeComputerImageStreamStatus(previous, next)).toBe(next);
  });
});

// Hook coverage for the disable path: the stills stream shares its canvas with
// the preview tap, and the canvas never gets wiped — a held frame outlives
// whichever source drew it until another frame paints over it. Uses the same
// slot-tracked React harness as useComputerPreviewTap.test.ts, with the frame
// source stubbed to capture its handlers so frames can be fed without a
// WebSocket.

const reactHarness = vi.hoisted(() => {
  interface EffectSlot {
    deps?: readonly unknown[];
    cleanup?: (() => void) | undefined;
    value?: unknown;
    setter?: (...args: never[]) => void;
    refObj?: { current: unknown };
  }

  let slots: EffectSlot[] = [];
  let cursor = 0;
  const nextSlot = () => {
    const slot = (slots[cursor] ??= {});
    cursor += 1;
    return slot;
  };
  // oxlint-disable-next-line consistent-function-scoping
  const depsEqual = (left: readonly unknown[] | undefined, right: readonly unknown[]) =>
    left !== undefined &&
    left.length === right.length &&
    left.every((value, index) => Object.is(value, right[index]));

  return {
    beginRender() {
      cursor = 0;
    },
    reset() {
      for (const slot of slots) slot.cleanup?.();
      slots = [];
      cursor = 0;
    },
    useState<T>(initial: T | (() => T)): [T, (value: T | ((previous: T) => T)) => void] {
      const slot = nextSlot();
      if (slot.setter === undefined) {
        slot.value = typeof initial === "function" ? (initial as () => T)() : initial;
        slot.setter = (value: T | ((previous: T) => T)) => {
          slot.value =
            typeof value === "function" ? (value as (previous: T) => T)(slot.value as T) : value;
        };
      }
      return [slot.value as T, slot.setter as (value: T | ((previous: T) => T)) => void];
    },
    useRef<T>(initial: T): { current: T } {
      const slot = nextSlot();
      slot.refObj ??= { current: initial };
      return slot.refObj as { current: T };
    },
    useEffect(effect: () => void | (() => void), deps: readonly unknown[]) {
      const slot = nextSlot();
      if (depsEqual(slot.deps, deps)) return;
      slot.cleanup?.();
      slot.deps = deps;
      slot.cleanup = effect() ?? undefined;
    },
  };
});

const registry = vi.hoisted(() => ({}));

vi.mock("react", () => ({
  useContext: () => registry,
  useEffect: reactHarness.useEffect,
  useRef: reactHarness.useRef,
  useState: reactHarness.useState,
}));

const frameSourceHarness = vi.hoisted(() => ({
  handlers: null as {
    onFrame: (frame: ComputerFrame) => void;
    onReset: (reason: string) => void;
  } | null,
  opened: 0,
  urls: [] as string[],
  close: vi.fn(),
  requestResync: vi.fn(),
  resolveUrl: vi.fn(),
}));

const connection = vi.hoisted(() => ({ generation: 1 as number | null }));

vi.mock("~/hooks/useComputerEventBridge", () => ({
  useConnectedGeneration: () => connection.generation,
}));

vi.mock("./computerFrameSocketUrl", () => ({
  resolveComputerFrameSocketUrl: frameSourceHarness.resolveUrl,
}));

vi.mock("~/lib/computerFrameSource", () => ({
  createComputerFrameSource: (options: {
    url: string;
    handlers: {
      onFrame: (frame: ComputerFrame) => void;
      onReset: (reason: string) => void;
    };
  }) => {
    frameSourceHarness.handlers = options.handlers;
    frameSourceHarness.opened += 1;
    frameSourceHarness.urls.push(options.url);
    return {
      requestResync: frameSourceHarness.requestResync,
      close: frameSourceHarness.close,
    };
  },
}));

const COMPUTER_ID = ComputerId.make("desktop");
const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

interface FakeCanvas {
  canvas: {
    width: number;
    height: number;
    getContext: ReturnType<typeof vi.fn>;
  };
  context: {
    drawImage: ReturnType<typeof vi.fn>;
    clearRect: ReturnType<typeof vi.fn>;
  };
  canvasRef: { current: unknown };
}

function createCanvas(): FakeCanvas {
  const context = { drawImage: vi.fn(), clearRect: vi.fn() };
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => context) };
  return { canvas, context, canvasRef: { current: canvas } };
}

function feedSequence(sequence: number): void {
  frameSourceHarness.handlers?.onFrame({
    header: { computerId: COMPUTER_ID, sequence },
    payload: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  } as unknown as ComputerFrame);
}

/** The PNG decode awaits a mocked createImageBitmap; a few microtask turns settle it. */
async function flushDecode(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function renderStream(input: {
  enabled: boolean;
  computerId?: ComputerId | null;
  canvasRef?: { current: unknown };
}) {
  reactHarness.beginRender();
  return useComputerImageStream({
    canvasRef: (input.canvasRef ?? { current: null }) as React.RefObject<HTMLCanvasElement | null>,
    environmentId: ENVIRONMENT_ID,
    computerId: input.computerId ?? COMPUTER_ID,
    enabled: input.enabled,
  });
}

const documentHarness = vi.hoisted(() => ({
  visibility: "visible" as "visible" | "hidden",
  listeners: new Set<() => void>(),
}));

function stubVisibleDocument(): void {
  documentHarness.visibility = "visible";
  documentHarness.listeners.clear();
  vi.stubGlobal("document", {
    get visibilityState() {
      return documentHarness.visibility;
    },
    addEventListener: (_type: string, listener: () => void) =>
      documentHarness.listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) =>
      documentHarness.listeners.delete(listener),
  });
}

/** Flip visibility and re-render, as React would after the state update. */
function setVisibility(value: "visible" | "hidden", canvasRef: { current: unknown }) {
  documentHarness.visibility = value;
  for (const listener of documentHarness.listeners) listener();
  return renderStream({ enabled: true, canvasRef });
}

const createImageBitmapMock = vi.hoisted(() => vi.fn());

/** Settles the hook's URL resolution: its `.then` runs before this await resumes. */
async function urlResolved(call = frameSourceHarness.resolveUrl.mock.results.length - 1) {
  await frameSourceHarness.resolveUrl.mock.results[call]?.value;
}

beforeEach(() => {
  reactHarness.reset();
  connection.generation = 1;
  frameSourceHarness.handlers = null;
  frameSourceHarness.opened = 0;
  frameSourceHarness.urls = [];
  frameSourceHarness.resolveUrl.mockReset();
  frameSourceHarness.resolveUrl.mockImplementation(
    async (_registry: unknown, environmentId: string, computerId: string) =>
      `wss://remote.example.com/ws/computer-frames?computerId=${computerId}&env=${environmentId}&wsTicket=${frameSourceHarness.urls.length}`,
  );
  frameSourceHarness.close.mockClear();
  frameSourceHarness.requestResync.mockClear();
  vi.unstubAllGlobals();
  createImageBitmapMock.mockReset();
  createImageBitmapMock.mockImplementation(async () => ({
    width: 320,
    height: 200,
    close: vi.fn(),
  }));
  vi.stubGlobal("createImageBitmap", createImageBitmapMock);
  stubVisibleDocument();
});

describe("useComputerImageStream disable path", () => {
  it("leaves a canvas it never drew alone when disabled", async () => {
    const { context, canvasRef } = createCanvas();

    // The handoff shape: the stream was enabled while the tap owned the
    // canvas, so no stills frame ever decoded before the tap took over.
    renderStream({ enabled: true, canvasRef });
    await flushDecode();
    renderStream({ enabled: false, canvasRef });

    expect(frameSourceHarness.close).toHaveBeenCalledOnce();
    expect(context.drawImage).not.toHaveBeenCalled();
    expect(context.clearRect).not.toHaveBeenCalled();
  });

  it("keeps the canvas it drew once disabled", async () => {
    const { canvas, context, canvasRef } = createCanvas();

    renderStream({ enabled: true, canvasRef });
    await flushDecode();
    feedSequence(1);
    await flushDecode();

    expect(createImageBitmapMock).toHaveBeenCalledOnce();
    expect(canvas.width).toBe(320);
    expect(canvas.height).toBe(200);
    expect(context.drawImage).toHaveBeenCalledOnce();
    expect(renderStream({ enabled: true, canvasRef }).dimensions).toEqual({
      width: 320,
      height: 200,
    });

    renderStream({ enabled: false, canvasRef });
    expect(frameSourceHarness.close).toHaveBeenCalledOnce();
    // The frame stays on the canvas: the tap or a re-subscribed stream paints
    // over it, so clearing would only blank the preview in between.
    expect(context.clearRect).not.toHaveBeenCalled();
    // The stream's own dims reset with the subscription — the card latches the
    // last decoded size itself so the held frame's aspect survives.
    expect(renderStream({ enabled: false, canvasRef }).dimensions).toBeNull();
  });
});

// Ported from useComputerImageStream.browser.tsx: the same scenarios driven
// through the slot harness with a stubbed document and fake bitmaps.
describe("useComputerImageStream lifecycle", () => {
  it("closes hidden streams and restores dimensions when equal-sized frames resume", async () => {
    const { canvasRef } = createCanvas();
    renderStream({ enabled: true, canvasRef });
    await flushDecode();
    expect(frameSourceHarness.opened).toBe(1);
    feedSequence(1);
    await flushDecode();
    expect(renderStream({ enabled: true, canvasRef }).dimensions).toEqual({
      width: 320,
      height: 200,
    });

    setVisibility("hidden", canvasRef);
    expect(frameSourceHarness.close).toHaveBeenCalledOnce();
    expect(renderStream({ enabled: true, canvasRef }).dimensions).toBeNull();

    setVisibility("visible", canvasRef);
    await flushDecode();
    expect(frameSourceHarness.opened).toBe(2);
    feedSequence(1);
    await flushDecode();
    const resumed = renderStream({ enabled: true, canvasRef });
    expect(resumed.dimensions).toEqual({ width: 320, height: 200 });
    expect(resumed.status.kind).toBe("streaming");
    reactHarness.reset();
    expect(frameSourceHarness.close).toHaveBeenCalledTimes(2);
  });

  it("closes an in-flight bitmap without drawing it after the document hides", async () => {
    const { context, canvasRef } = createCanvas();
    const bitmap = { width: 320, height: 200, close: vi.fn() };
    let finish!: (value: typeof bitmap) => void;
    createImageBitmapMock.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    renderStream({ enabled: true, canvasRef });
    await flushDecode();
    feedSequence(1);
    setVisibility("hidden", canvasRef);
    expect(frameSourceHarness.close).toHaveBeenCalledOnce();
    finish(bitmap);
    await flushDecode();
    expect(bitmap.close).toHaveBeenCalledOnce();
    expect(context.drawImage).not.toHaveBeenCalled();
    const hidden = renderStream({ enabled: true, canvasRef });
    expect(hidden.dimensions).toBeNull();
    expect(hidden.status.kind).toBe("idle");
  });

  it("bounds decoding to one active frame and the newest pending frame", async () => {
    const { canvasRef } = createCanvas();
    const first = { width: 320, height: 200, close: vi.fn() };
    const last = { width: 320, height: 200, close: vi.fn() };
    let finish!: (value: typeof first) => void;
    createImageBitmapMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(last);
    renderStream({ enabled: true, canvasRef });
    await flushDecode();
    for (const sequence of [1, 2, 3]) {
      frameSourceHarness.handlers?.onFrame({
        header: { computerId: COMPUTER_ID, sequence },
        payload: new Uint8Array([sequence]),
      } as unknown as ComputerFrame);
    }
    expect(createImageBitmapMock).toHaveBeenCalledTimes(1);
    finish(first);
    await flushDecode();
    expect(createImageBitmapMock).toHaveBeenCalledTimes(2);
    const blob = createImageBitmapMock.mock.calls[1]![0] as Blob;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([3]));
    await flushDecode();
    expect(last.close).toHaveBeenCalledOnce();
    expect(first.close).toHaveBeenCalledOnce();
  });
});

describe("useComputerImageStream frame socket authorization", () => {
  it("mints a fresh socket URL for every reconnect", async () => {
    vi.useFakeTimers();
    try {
      const { canvasRef } = createCanvas();
      renderStream({ enabled: true, canvasRef });
      await flushDecode();
      expect(frameSourceHarness.resolveUrl).toHaveBeenCalledWith(
        expect.anything(),
        ENVIRONMENT_ID,
        COMPUTER_ID,
      );
      frameSourceHarness.handlers?.onReset("closed");
      expect(renderStream({ enabled: true, canvasRef }).status.kind).toBe("connecting");
      await vi.advanceTimersByTimeAsync(500);
      expect(frameSourceHarness.resolveUrl).toHaveBeenCalledTimes(2);
      expect(frameSourceHarness.urls).toHaveLength(2);
      expect(frameSourceHarness.urls[0]).not.toBe(frameSourceHarness.urls[1]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries with backoff while the environment cannot mint a URL", async () => {
    vi.useFakeTimers();
    try {
      frameSourceHarness.resolveUrl.mockResolvedValue(null);
      const { canvasRef } = createCanvas();
      renderStream({ enabled: true, canvasRef });
      await flushDecode();
      expect(frameSourceHarness.opened).toBe(0);
      expect(renderStream({ enabled: true, canvasRef }).status.kind).toBe("connecting");
      await vi.advanceTimersByTimeAsync(500);
      expect(frameSourceHarness.resolveUrl).toHaveBeenCalledTimes(2);
      reactHarness.reset();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(frameSourceHarness.resolveUrl).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a URL that resolves after the stream was disabled", async () => {
    let resolveUrl!: (url: string) => void;
    frameSourceHarness.resolveUrl.mockReturnValue(
      new Promise<string>((resolve) => {
        resolveUrl = resolve;
      }),
    );
    const { canvasRef } = createCanvas();
    renderStream({ enabled: true, canvasRef });
    renderStream({ enabled: false, canvasRef });
    resolveUrl("wss://remote.example.com/ws/computer-frames?computerId=desktop");
    await flushDecode();
    expect(frameSourceHarness.opened).toBe(0);
  });
});

describe("useComputerImageStream connection lifecycle", () => {
  it("closes the stream when the environment disconnects and retries nothing", async () => {
    vi.useFakeTimers();
    try {
      const { canvasRef } = createCanvas();
      renderStream({ enabled: true, canvasRef });
      await urlResolved();
      expect(frameSourceHarness.opened).toBe(1);

      connection.generation = null;
      renderStream({ enabled: true, canvasRef });
      expect(renderStream({ enabled: true, canvasRef }).status.kind).toBe("idle");
      expect(frameSourceHarness.close).toHaveBeenCalledOnce();
      // A late close from the dead socket schedules nothing.
      frameSourceHarness.handlers?.onReset("closed");
      await vi.advanceTimersByTimeAsync(10_000);
      expect(frameSourceHarness.resolveUrl).toHaveBeenCalledOnce();

      connection.generation = 2;
      renderStream({ enabled: true, canvasRef });
      await urlResolved();
      expect(frameSourceHarness.opened).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses the socket URL after a stream that delivered frames closes", async () => {
    vi.useFakeTimers();
    try {
      const { canvasRef } = createCanvas();
      renderStream({ enabled: true, canvasRef });
      await urlResolved();
      feedSequence(1);
      frameSourceHarness.handlers?.onReset("closed");
      await vi.advanceTimersByTimeAsync(500);
      expect(frameSourceHarness.resolveUrl).toHaveBeenCalledOnce();
      expect(frameSourceHarness.urls).toEqual([
        frameSourceHarness.urls[0],
        frameSourceHarness.urls[0],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up with Live view unavailable when sockets keep closing without a frame", async () => {
    vi.useFakeTimers();
    try {
      const { canvasRef } = createCanvas();
      renderStream({ enabled: true, canvasRef });
      await urlResolved();
      for (let attempt = 0; attempt < 5; attempt += 1) {
        frameSourceHarness.handlers?.onReset("closed");
        await vi.advanceTimersByTimeAsync(5_000);
      }
      expect(frameSourceHarness.opened).toBe(6);
      frameSourceHarness.handlers?.onReset("closed");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(frameSourceHarness.opened).toBe(6);
      expect(frameSourceHarness.resolveUrl).toHaveBeenCalledTimes(6);
      expect(renderStream({ enabled: true, canvasRef }).status).toEqual({
        kind: "error",
        message: COMPUTER_LIVE_VIEW_UNAVAILABLE,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
