import { SNAP_SHOT_EXPORT_MAX_BYTES, type SnapShotSource } from "@spiritdevs/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  annotationBounds,
  arrowHead,
  boundedCrop,
  exportSnapShot,
  moveAnnotation,
  rectangleBetween,
  resizeAnnotation,
  sourceAfterCrop,
  type Annotation,
} from "./editorModel";

const arrow: Annotation = {
  id: "arrow",
  tool: "arrow",
  points: [
    { x: 120, y: 80 },
    { x: 20, y: 40 },
  ],
  color: "#ed3b32",
  width: 4,
  fontSize: 26,
};

afterEach(() => vi.unstubAllGlobals());

describe("annotation geometry", () => {
  it("moves and resizes a backwards arrow without reversing its direction", () => {
    const resized = resizeAnnotation(arrow, { x: 30, y: 50, width: 200, height: 80 });
    expect(resized.points).toEqual([
      { x: 230, y: 130 },
      { x: 30, y: 50 },
    ]);
    expect(moveAnnotation(resized, { x: -10, y: 30 }).points).toEqual([
      { x: 220, y: 160 },
      { x: 20, y: 80 },
    ]);
    expect(arrow.points).toEqual([
      { x: 120, y: 80 },
      { x: 20, y: 40 },
    ]);
    expect(arrowHead(resized)[1]).toEqual({ x: 30, y: 50 });
  });

  it("uses all freehand points when calculating selection bounds", () => {
    expect(
      annotationBounds({
        ...arrow,
        tool: "pen",
        points: [
          { x: 10, y: 20 },
          { x: -30, y: 70 },
          { x: 80, y: -10 },
          { x: 20, y: 30 },
        ],
      }),
    ).toEqual({ x: -30, y: -10, width: 110, height: 80 });
  });

  it("normalizes backwards region selection and intersects the existing crop", () => {
    const selection = rectangleBetween({ x: 220.4, y: 120.6 }, { x: 20.2, y: 10.2 });
    expect(boundedCrop(selection, { x: 30, y: 40, width: 150, height: 100 })).toEqual({
      x: 30,
      y: 40,
      width: 150,
      height: 81,
    });
    expect(
      boundedCrop({ x: 999, y: 999, width: 0, height: 0 }, { x: 0, y: 0, width: 100, height: 100 }),
    ).toEqual({ x: 99, y: 99, width: 1, height: 1 });
  });
});

describe("crop provenance", () => {
  const source: SnapShotSource = {
    kind: "snap-shot",
    capturedAt: "2026-09-12T00:00:00.000Z",
    appName: "Browser",
    windowTitle: "Project",
    captureType: "screen",
    captureBounds: { x: -1440, y: 100, width: 1440, height: 900 },
    accessibleText: "Text outside the crop",
    accessibility: { format: "flat-text", text: "Text outside the crop", truncated: false },
  };

  it("removes text metadata on crop and maps retina pixels into negative display coordinates", () => {
    const cropped = sourceAfterCrop(
      source,
      { x: 200, y: 100, width: 800, height: 600 },
      { width: 2880, height: 1800 },
    );
    expect(cropped).toEqual({
      kind: "snap-shot",
      capturedAt: source.capturedAt,
      appName: "Browser",
      windowTitle: "Project",
      captureType: "region",
      captureBounds: { x: -1340, y: 150, width: 400, height: 300 },
    });
    expect(source.accessibleText).toBe("Text outside the crop");
  });

  it("preserves the complete metadata when crop is undone", () => {
    expect(
      sourceAfterCrop(
        source,
        { x: 0, y: 0, width: 2880, height: 1800 },
        { width: 2880, height: 1800 },
      ),
    ).toBe(source);
  });
});

describe("PNG export", () => {
  it("exports cropped original pixels and offsets annotations in the same coordinate system", () => {
    const context = {
      drawImage: vi.fn(),
      translate: vi.fn(),
      scale: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      strokeRect: vi.fn(),
      fillText: vi.fn(),
    };
    const canvas = {
      width: 0,
      height: 0,
      getContext: vi.fn(() => context),
      toDataURL: vi.fn(() => "data:image/png;base64,edited"),
    };
    vi.stubGlobal("window", { document: { createElement: vi.fn(() => canvas) } });
    const image = {} as HTMLImageElement;
    const result = exportSnapShot(image, {
      crop: { x: 200, y: 100, width: 800, height: 600 },
      annotations: [
        {
          ...arrow,
          tool: "rectangle",
          points: [
            { x: 220, y: 130 },
            { x: 360, y: 190 },
          ],
        },
        { ...arrow, id: "text", tool: "text", points: [{ x: 300, y: 200 }], text: "First\nSecond" },
      ],
    });
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    expect(context.drawImage).toHaveBeenCalledExactlyOnceWith(
      image,
      200,
      100,
      800,
      600,
      0,
      0,
      800,
      600,
    );
    expect(context.translate).toHaveBeenCalledExactlyOnceWith(-200, -100);
    expect(context.strokeRect).toHaveBeenCalledExactlyOnceWith(220, 130, 140, 60);
    expect(context.fillText.mock.calls).toEqual([
      ["First", 300, 200],
      ["Second", 300, 232.5],
    ]);
    expect(canvas.toDataURL).toHaveBeenCalledExactlyOnceWith("image/png");
    expect(result).toEqual({
      dataUrl: "data:image/png;base64,edited",
      imageSize: { width: 800, height: 600 },
    });
  });

  it("reduces oversized PNGs until they fit, redrawing annotations with matching scale", () => {
    const context = {
      drawImage: vi.fn(),
      scale: vi.fn(),
      translate: vi.fn(),
      save: vi.fn(),
      restore: vi.fn(),
      beginPath: vi.fn(),
      strokeRect: vi.fn(),
    };
    const oversized =
      "data:image/png;base64," + "A".repeat(Math.ceil((SNAP_SHOT_EXPORT_MAX_BYTES + 3) / 3) * 4);
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toDataURL: vi
        .fn()
        .mockReturnValueOnce(oversized)
        .mockReturnValueOnce(oversized)
        .mockReturnValue("data:image/png;base64,YQ=="),
    };
    vi.stubGlobal("window", { document: { createElement: () => canvas } });
    const image = {} as HTMLImageElement;
    const result = exportSnapShot(image, {
      crop: { x: 20, y: 10, width: 1000, height: 500 },
      annotations: [{ ...arrow, tool: "rectangle" }],
    });
    expect(result).toEqual({
      dataUrl: "data:image/png;base64,YQ==",
      imageSize: { width: 640, height: 320 },
    });
    expect(context.drawImage.mock.calls).toEqual([
      [image, 20, 10, 1000, 500, 0, 0, 1000, 500],
      [image, 20, 10, 1000, 500, 0, 0, 800, 400],
      [image, 20, 10, 1000, 500, 0, 0, 640, 320],
    ]);
    expect(context.scale.mock.calls).toEqual([
      [1, 1],
      [0.8, 0.8],
      [0.64, 0.64],
    ]);
    expect(context.translate.mock.calls).toEqual([
      [-20, -10],
      [-20, -10],
      [-20, -10],
    ]);
    expect(context.strokeRect).toHaveBeenCalledTimes(3);
  });

  it("bounds export dimensions even when a PNG compresses well", () => {
    const context = { drawImage: vi.fn(), scale: vi.fn(), translate: vi.fn() };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toDataURL: () => "data:image/png;base64,YQ==",
    };
    vi.stubGlobal("window", { document: { createElement: () => canvas } });
    const result = exportSnapShot({} as HTMLImageElement, {
      crop: { x: 0, y: 0, width: 20000, height: 4000 },
      annotations: [],
    });
    expect(result.imageSize.width).toBeLessThanOrEqual(16384);
    expect(result.imageSize.width * result.imageSize.height).toBeLessThanOrEqual(40000000);
  });

  it("reports a failed canvas export rather than returning an empty image", () => {
    vi.stubGlobal("window", { document: { createElement: () => ({ getContext: () => null }) } });
    expect(() =>
      exportSnapShot({} as HTMLImageElement, {
        annotations: [],
        crop: { x: 0, y: 0, width: 100, height: 100 },
      }),
    ).toThrow("could not create an image");
  });
});
