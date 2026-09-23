import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, createHash: vi.fn(actual.createHash) };
});

import { ComputerTargetError } from "./computerErrors.ts";
import {
  SCREENSHOT_FRAMES_PER_THREAD,
  ScreenshotFrameRegistry,
  screenshotDeltaToDesktop,
  screenshotPointToDesktop,
  screenshotRectToDesktop,
  type ScreenshotFrame,
} from "./screenshotFrames.ts";

/** A 400×800 desktop rect at (1050, 120) captured into a 200×400 image. */
const HALF: ScreenshotFrame = {
  id: "shot-1",
  width: 200,
  height: 400,
  region: { x: 1_050, y: 120, width: 400, height: 800 },
  scale: 0.5,
};

function shot(width: number, height: number, region = { x: 0, y: 0, width, height }) {
  return { width, height, region, scale: width / region.width };
}

describe("screenshotPointToDesktop", () => {
  it.effect("adds the region offset and undoes the downscale", () =>
    Effect.gen(function* () {
      expect(yield* screenshotPointToDesktop(HALF, 100, 100)).toEqual({ x: 1_250, y: 320 });
      expect(yield* screenshotPointToDesktop(HALF, 0, 0)).toEqual({ x: 1_050, y: 120 });
    }),
  );

  it.effect("lands a far-edge pixel on the region's last desktop pixel", () =>
    Effect.gen(function* () {
      // Models put controls flush against a border at x === width; that is the
      // last pixel the picture shows, not the first one past it.
      expect(yield* screenshotPointToDesktop(HALF, 200, 400)).toEqual({ x: 1_449, y: 919 });
    }),
  );

  it.effect("refuses a point the picture does not show", () =>
    Effect.gen(function* () {
      const outside: ReadonlyArray<readonly [number, number]> = [
        [201, 10],
        [10, 401],
        [-1, 10],
        [Number.NaN, 10],
      ];
      for (const [x, y] of outside) {
        expect(yield* Effect.flip(screenshotPointToDesktop(HALF, x, y))).toBeInstanceOf(
          ComputerTargetError,
        );
      }
      expect(yield* Effect.flip(screenshotPointToDesktop(HALF, 201, 10))).toMatchObject({
        code: "computer_target_offscreen",
        message: expect.stringContaining("200x400 screenshot shot-1"),
      });
    }),
  );
});

describe("screenshotRectToDesktop", () => {
  it.effect("maps and clips a rect to what the frame covers", () =>
    Effect.gen(function* () {
      expect(
        yield* screenshotRectToDesktop(HALF, { x: 100, y: 300, width: 200, height: 200 }),
      ).toEqual({ x: 1_250, y: 720, width: 200, height: 200 });
      expect(
        yield* screenshotRectToDesktop(HALF, { x: -10, y: -10, width: 20, height: 20 }),
      ).toEqual({ x: 1_050, y: 120, width: 20, height: 20 });
    }),
  );

  it.effect("refuses a rect with nothing of the picture in it", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        screenshotRectToDesktop(HALF, { x: 200, y: 0, width: 10, height: 10 }),
      );
      expect(error).toBeInstanceOf(ComputerTargetError);
    }),
  );
});

describe("screenshotDeltaToDesktop", () => {
  it("scales a distance the same way as a point", () => {
    expect(screenshotDeltaToDesktop(HALF, 40, -10)).toEqual({ deltaX: 80, deltaY: -20 });
  });
});

describe("ScreenshotFrameRegistry", () => {
  it.effect("hands out sequential ids and resolves the latest by default", () =>
    Effect.gen(function* () {
      const frames = new ScreenshotFrameRegistry();
      expect(frames.record("t", shot(100, 100))?.id).toBe("shot-1");
      expect(frames.record("t", shot(50, 50))?.id).toBe("shot-2");
      expect((yield* frames.resolve("t")).id).toBe("shot-2");
      expect((yield* frames.resolve("t", "shot-1")).width).toBe(100);
    }),
  );

  it.effect("refuses a thread that has not seen a screenshot, and an unknown id", () =>
    Effect.gen(function* () {
      const frames = new ScreenshotFrameRegistry();
      expect(yield* Effect.flip(frames.resolve("t"))).toMatchObject({
        code: "computer_target_invalid",
      });
      frames.record("t", shot(100, 100));
      expect(yield* Effect.flip(frames.resolve("t", "shot-7"))).toMatchObject({
        code: "computer_target_not_found",
        message: expect.stringContaining("shot-1"),
      });
      // Another thread's picture is not this thread's frame.
      expect(yield* Effect.flip(frames.resolve("u"))).toBeInstanceOf(ComputerTargetError);
    }),
  );

  it.effect("keeps a bounded number of frames per thread and forgets the oldest", () =>
    Effect.gen(function* () {
      const frames = new ScreenshotFrameRegistry();
      for (let index = 0; index <= SCREENSHOT_FRAMES_PER_THREAD; index += 1) {
        frames.record("t", shot(100, 100));
      }
      expect(yield* Effect.flip(frames.resolve("t", "shot-1"))).toBeInstanceOf(ComputerTargetError);
      expect((yield* frames.resolve("t", "shot-2")).id).toBe("shot-2");
    }),
  );

  it.effect("records nothing for a screenshot that carries no mapping", () =>
    Effect.gen(function* () {
      const frames = new ScreenshotFrameRegistry();
      expect(frames.record("t", { width: 10, height: 10 })).toBeUndefined();
      expect(yield* Effect.flip(frames.resolve("t"))).toBeInstanceOf(ComputerTargetError);
    }),
  );
});

describe("screenshot reuse", () => {
  const image = {
    ...shot(200, 400, { x: 1050, y: 120, width: 400, height: 800 }),
    mimeType: "image/png" as const,
    sizeBytes: 3,
    bytesBase64: "YWJj",
    capturedAt: "2026-09-05T00:00:00.000Z",
  };

  it("hashes a shared capture once while still checking new captures by content", () => {
    const frames = new ScreenshotFrameRegistry();
    const hash = vi.mocked(NodeCrypto.createHash);
    hash.mockClear();
    const frame = frames.record("thread-a", image, "window-a");
    frames.record("thread-b", image, "window-a");
    for (let index = 0; index < 5; index += 1) {
      expect(frames.matchLatest("thread-a", image, "window-a")).toBe(frame);
    }
    expect(hash).toHaveBeenCalledTimes(1);

    expect(frames.matchLatest("thread-a", { ...image }, "window-a")).toBe(frame);
    expect(hash).toHaveBeenCalledTimes(2);
    expect(
      frames.matchLatest("thread-a", { ...image, bytesBase64: "ZGVm" }, "window-a"),
    ).toBeUndefined();
    expect(hash).toHaveBeenCalledTimes(3);
  });

  it("requires identical pixels, window, geometry, and scale in the latest delivered frame", () => {
    const frames = new ScreenshotFrameRegistry();
    const frame = frames.record("thread-a", image, "window-a");
    expect(
      frames.matchLatest(
        "thread-a",
        { ...image, capturedAt: "2026-09-05T00:01:00.000Z" },
        "window-a",
      ),
    ).toBe(frame);
    expect(frames.matchLatest("thread-a", image, "window-b")).toBeUndefined();
    expect(frames.matchLatest("thread-b", image, "window-a")).toBeUndefined();
    for (const changed of [
      { ...image, scale: 1 },
      { ...image, width: 201 },
      { ...image, bytesBase64: "ZGVm" },
      { ...image, region: { ...image.region, x: 600 } },
    ]) {
      expect(frames.matchLatest("thread-a", changed, "window-a")).toBeUndefined();
    }
    frames.record("thread-b", image, "window-a");
    expect(frames.matchLatest("thread-a", image, "window-a")).toBe(frame);
    frames.record("thread-a", image, "window-b");
    expect(frames.matchLatest("thread-a", image, "window-a")).toBeUndefined();
  });

  it.effect("invalidates the active frame after delivering an image without geometry", () =>
    Effect.gen(function* () {
      const frames = new ScreenshotFrameRegistry();
      frames.record("thread-a", image, "window-a");
      frames.record("thread-a", { width: 1, height: 1, bytesBase64: "YWJj" });
      expect(frames.matchLatest("thread-a", image, "window-a")).toBeUndefined();
      expect((yield* Effect.flip(frames.resolve("thread-a"))).message).toContain("No screenshot");
    }),
  );
});
