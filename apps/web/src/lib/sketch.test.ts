import { createCanvas, loadImage } from "@napi-rs/canvas";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  decodeSketchScene,
  drawSketchElement,
  drawSketchScene,
  exportSketch,
  moveSketchElement,
  sketchElementBounds,
  sketchElementTouches,
  sketchFontSize,
  sketchSceneBounds,
  SKETCH_FONT_FAMILY,
  SKETCH_FONT_WEIGHT,
  SKETCH_TEXT_LINE_HEIGHT,
  type SketchElement,
} from "./sketch";

function element(overrides: Partial<SketchElement> = {}): SketchElement {
  return {
    id: "element-1",
    kind: "line",
    color: "#000000",
    size: 4,
    points: [
      { x: 10, y: 20 },
      { x: 110, y: 80 },
    ],
    ...overrides,
  };
}

function installCanvas() {
  const canvas = createCanvas(1, 1);
  vi.stubGlobal("document", { createElement: () => canvas });
  return canvas;
}

afterEach(() => vi.unstubAllGlobals());

describe("sketch bounds", () => {
  it.each(["line", "rectangle", "ellipse"] as const)(
    "includes the stroke of a backwards %s",
    (kind) => {
      expect(
        sketchElementBounds(
          element({
            kind,
            points: [
              { x: 110, y: 80 },
              { x: 10, y: 20 },
            ],
          }),
        ),
      ).toEqual({ x: 8, y: 18, width: 104, height: 64 });
    },
  );

  it("includes every freehand point and single-point dots", () => {
    expect(
      sketchElementBounds(
        element({
          kind: "pen",
          points: [
            { x: 0, y: 0 },
            { x: -10, y: 20 },
            { x: 30, y: -40 },
          ],
        }),
      ),
    ).toEqual({ x: -12, y: -42, width: 44, height: 64 });
    expect(sketchElementBounds(element({ kind: "pen", points: [{ x: 10, y: 20 }] }))).toEqual({
      x: 8,
      y: 18,
      width: 4,
      height: 4,
    });
  });

  it("includes the open arrowhead even when it extends past a short shaft", () => {
    const bounds = sketchElementBounds(
      element({
        kind: "arrow",
        points: [
          { x: 0, y: 0 },
          { x: 5, y: 0 },
        ],
      }),
    );
    expect(bounds.x).toBeCloseTo(5 - 16 * Math.cos(Math.PI / 6) - 2);
    expect(bounds.y).toBeCloseTo(-10);
    expect(bounds.height).toBeCloseTo(20);
    expect(bounds.x + bounds.width).toBeCloseTo(7);
  });

  it("measures multiline text deterministically without a canvas", () => {
    vi.stubGlobal("document", undefined);
    expect(sketchFontSize(2)).toBe(16);
    expect(sketchFontSize(24)).toBe(56);
    const text = element({ kind: "text", size: 2, text: "abcd\nx", points: [{ x: 10, y: 20 }] });
    expect(sketchElementBounds(text)).toEqual({ x: 10, y: 20, width: 38.4, height: 36 });
  });

  it("uses canvas text metrics with the renderer's font", () => {
    const measureText = vi.fn(() => ({
      width: 30,
      actualBoundingBoxLeft: 2,
      actualBoundingBoxRight: 32,
      actualBoundingBoxAscent: -3,
      actualBoundingBoxDescent: 17,
    }));
    const context = { font: "", textBaseline: "", measureText };
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => context }) });
    expect(sketchElementBounds(element({ kind: "text", size: 2, text: "text" }))).toEqual({
      x: 8,
      y: 20,
      width: 34,
      height: 17,
    });
    expect(context.font).toBe(`${SKETCH_FONT_WEIGHT} 16px ${SKETCH_FONT_FAMILY}`);
    expect(context.textBaseline).toBe("top");
  });

  it("unions element bounds and returns null for an empty scene", () => {
    expect(sketchSceneBounds([])).toBeNull();
    expect(
      sketchSceneBounds([
        element(),
        element({
          points: [
            { x: -10, y: -20 },
            { x: 0, y: 0 },
          ],
        }),
      ]),
    ).toEqual({ x: -12, y: -22, width: 124, height: 104 });
  });
});

describe("sketch eraser", () => {
  it("touches a stroke only within the eraser radius plus half its width", () => {
    const line = element({
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
    });
    expect(sketchElementTouches(line, { x: 50, y: 7 }, 5)).toBe(true);
    expect(sketchElementTouches(line, { x: 50, y: 7.1 }, 5)).toBe(false);
    expect(sketchElementTouches(line, { x: -7, y: 0 }, 5)).toBe(true);
    expect(sketchElementTouches(line, { x: -7.1, y: 0 }, 5)).toBe(false);
  });

  it("tests every pen segment, including single-point and repeated dots", () => {
    const pen = element({
      kind: "pen",
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
    });
    expect(sketchElementTouches(pen, { x: 100, y: 50 }, 0)).toBe(true);
    expect(sketchElementTouches(pen, { x: 50, y: 50 }, 0)).toBe(false);
    for (const points of [
      [{ x: 0, y: 0 }],
      [
        { x: 0, y: 0 },
        { x: 0, y: 0 },
      ],
    ]) {
      const dot = element({ kind: "pen", points });
      expect(sketchElementTouches(dot, { x: 2, y: 0 }, 0)).toBe(true);
      expect(sketchElementTouches(dot, { x: 3, y: 0 }, 0)).toBe(false);
    }
  });

  it("misses the empty rectangle interior and touches edges and rounded corners", () => {
    const rect = element({
      kind: "rectangle",
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
    });
    expect(sketchElementTouches(rect, { x: 50, y: 50 }, 5)).toBe(false);
    expect(sketchElementTouches(rect, { x: 50, y: -7 }, 5)).toBe(true);
    expect(sketchElementTouches(rect, { x: 0, y: 0 }, 0)).toBe(false);
    const corner = 10 - 10 / Math.sqrt(2);
    expect(sketchElementTouches(rect, { x: corner, y: corner }, 0)).toBe(true);
  });

  it("touches the ellipse outline and misses its interior and box corners", () => {
    const ellipse = element({
      kind: "ellipse",
      points: [
        { x: 0, y: 0 },
        { x: 200, y: 100 },
      ],
    });
    expect(sketchElementTouches(ellipse, { x: 100, y: 50 }, 5)).toBe(false);
    expect(sketchElementTouches(ellipse, { x: 207, y: 50 }, 5)).toBe(true);
    expect(sketchElementTouches(ellipse, { x: 208, y: 50 }, 5)).toBe(false);
    expect(sketchElementTouches(ellipse, { x: 0, y: 0 }, 5)).toBe(false);
    expect(sketchElementTouches(ellipse, { x: 100, y: -7 }, 5)).toBe(true);
  });

  it("uses Euclidean distance near a narrow ellipse rather than radial distance", () => {
    const ellipse = element({
      kind: "ellipse",
      size: 2,
      points: [
        { x: -100, y: -10 },
        { x: 100, y: 10 },
      ],
    });
    const angle = Math.PI / 4;
    const x = 100 * Math.cos(angle);
    const y = 10 * Math.sin(angle);
    const nx = Math.cos(angle) / 100;
    const ny = Math.sin(angle) / 10;
    const length = Math.hypot(nx, ny);
    expect(
      sketchElementTouches(ellipse, { x: x + (nx / length) * 5.9, y: y + (ny / length) * 5.9 }, 5),
    ).toBe(true);
    expect(
      sketchElementTouches(ellipse, { x: x + (nx / length) * 6.1, y: y + (ny / length) * 6.1 }, 5),
    ).toBe(false);
    expect(
      sketchElementTouches(ellipse, { x: x - (nx / length) * 5, y: y - (ny / length) * 5 }, 5),
    ).toBe(true);
  });

  it("handles vertical and degenerate ellipses", () => {
    expect(
      sketchElementTouches(
        element({
          kind: "ellipse",
          points: [
            { x: -10, y: -100 },
            { x: 10, y: 100 },
          ],
        }),
        { x: 15, y: 0 },
        3,
      ),
    ).toBe(true);
    expect(
      sketchElementTouches(
        element({
          kind: "ellipse",
          points: [
            { x: 0, y: 0 },
            { x: 0, y: 100 },
          ],
        }),
        { x: 4, y: 50 },
        2,
      ),
    ).toBe(true);
  });

  it("includes arrowheads outside the shaft", () => {
    const arrow = element({
      kind: "arrow",
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
      ],
    });
    expect(sketchElementTouches(arrow, { x: 100 - 16 * Math.cos(Math.PI / 6), y: 8 }, 0)).toBe(
      true,
    );
    expect(sketchElementTouches(arrow, { x: 80, y: 8 }, 0)).toBe(false);
  });

  it("tests text bounds and the circular eraser around their corners", () => {
    vi.stubGlobal("document", undefined);
    const text = element({ kind: "text", text: "abcd", size: 2 });
    expect(sketchElementTouches(text, { x: 20, y: 25 }, 0)).toBe(true);
    expect(sketchElementTouches(text, { x: 7, y: 17 }, 4)).toBe(false);
    expect(sketchElementTouches(text, { x: 7, y: 17 }, 5)).toBe(true);
  });
});

describe("sketch editing and decoding", () => {
  it("moves every point without mutating the original", () => {
    const original = element({ kind: "pen", text: "keep" });
    const moved = moveSketchElement(original, { x: -5, y: 10 });
    expect(moved).toEqual({
      ...original,
      points: [
        { x: 5, y: 30 },
        { x: 105, y: 90 },
      ],
    });
    expect(original.points[0]).toEqual({ x: 10, y: 20 });
  });

  it("decodes valid scenes, including empty scenes and all tools", () => {
    expect(decodeSketchScene({ elements: [] })).toEqual({ elements: [] });
    const scene = {
      elements: (["pen", "rectangle", "ellipse", "line", "arrow", "text"] as const).map((kind) =>
        element({ kind }),
      ),
    };
    expect(decodeSketchScene(scene)).toEqual(scene);
  });

  it.each([
    null,
    {},
    { elements: "bad" },
    { elements: [element({ points: [] })] },
    { elements: [element({ size: 0 })] },
    { elements: [element({ size: Infinity })] },
    { elements: [element({ color: "red" })] },
    { elements: [element({ points: [{ x: NaN, y: 0 }] })] },
    { elements: [{ ...element(), kind: "unknown" }] },
    { elements: [{ ...element(), text: 123 }] },
  ])("rejects invalid persisted scene %j", (scene) => {
    expect(decodeSketchScene(scene)).toBeNull();
  });
});

describe("sketch rendering and export", () => {
  it("renders repeated freehand points as filled dots and smooths longer strokes", () => {
    const canvas = createCanvas(100, 100);
    const context = canvas.getContext("2d");
    const drawing = context as unknown as CanvasRenderingContext2D;
    drawSketchElement(
      drawing,
      element({
        kind: "pen",
        size: 10,
        points: [
          { x: 50, y: 50 },
          { x: 50, y: 50 },
        ],
      }),
    );
    expect([...context.getImageData(50, 50, 1, 1).data]).toEqual([0, 0, 0, 255]);
    const quadratic = vi.spyOn(context, "quadraticCurveTo");
    drawSketchElement(
      drawing,
      element({
        kind: "pen",
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 20 },
          { x: 30, y: 40 },
        ],
      }),
    );
    expect(quadratic).toHaveBeenCalledWith(10, 20, 20, 30);
  });

  it("renders shape interiors transparently, with open arrowheads and multiline text", () => {
    const canvas = createCanvas(200, 200);
    const context = canvas.getContext("2d");
    const drawing = context as unknown as CanvasRenderingContext2D;
    const fillText = vi.spyOn(context, "fillText");
    drawSketchScene(drawing, [
      element({
        kind: "rectangle",
        points: [
          { x: 10, y: 10 },
          { x: 90, y: 90 },
        ],
      }),
      element({
        kind: "ellipse",
        points: [
          { x: 110, y: 10 },
          { x: 190, y: 90 },
        ],
      }),
      element({
        kind: "arrow",
        points: [
          { x: 10, y: 110 },
          { x: 90, y: 110 },
        ],
      }),
      element({ kind: "text", size: 2, text: "one\ntwo", points: [{ x: 10, y: 140 }] }),
    ]);
    expect(context.getImageData(50, 50, 1, 1).data[3]).toBe(0);
    expect(context.getImageData(150, 50, 1, 1).data[3]).toBe(0);
    expect(context.getImageData(77, 113, 1, 1).data[3]).toBe(0);
    expect(fillText).toHaveBeenNthCalledWith(1, "one", 10, 140);
    expect(fillText).toHaveBeenNthCalledWith(2, "two", 10, 140 + 16 * SKETCH_TEXT_LINE_HEIGHT);
  });

  it("preserves the context's transform and drawing state", () => {
    const context = createCanvas(100, 100).getContext("2d");
    context.translate(10, 20);
    context.lineWidth = 9;
    context.strokeStyle = "#ff0000";
    const transform = context.getTransform();
    drawSketchElement(context as unknown as CanvasRenderingContext2D, element());
    expect(context.getTransform()).toEqual(transform);
    expect(context.lineWidth).toBe(9);
    context.resetTransform();
    context.strokeRect(20, 20, 20, 20);
    expect([...context.getImageData(20, 30, 1, 1).data]).toEqual([255, 0, 0, 255]);
  });

  it("exports actual PNG bytes cropped with default padding and opaque white", async () => {
    const canvas = installCanvas();
    const result = await exportSketch({
      elements: [
        element({
          points: [
            { x: -50, y: -30 },
            { x: 50, y: -30 },
          ],
        }),
      ],
    });
    expect(result).toMatchObject({ width: 336, height: 136 });
    expect(result.blob.type).toBe("image/png");
    const image = await loadImage(Buffer.from(await result.blob.arrayBuffer()));
    expect([image.width, image.height]).toEqual([336, 136]);
    expect([...canvas.getContext("2d").getImageData(0, 0, 1, 1).data]).toEqual([
      255, 255, 255, 255,
    ]);
    expect([...canvas.getContext("2d").getImageData(100, 68, 1, 1).data]).toEqual([0, 0, 0, 255]);
  });

  it("honors custom padding and pixel ratio", async () => {
    installCanvas();
    const result = await exportSketch({ elements: [element()] }, { padding: 5, pixelRatio: 1 });
    expect(result).toMatchObject({ width: 114, height: 74 });
  });

  it.each([
    [
      { x: 0, y: 0 },
      { x: 5000, y: 100 },
    ],
    [
      { x: 0, y: 0 },
      { x: 100, y: 5000 },
    ],
  ])("caps either side at 4096 while preserving scale", async (start, end) => {
    installCanvas();
    const result = await exportSketch(
      { elements: [element({ points: [start, end] })] },
      { padding: 0 },
    );
    expect(Math.max(result.width, result.height)).toBe(4096);
    expect(Math.min(result.width, result.height)).toBe(Math.ceil((104 * 4096) / 5004));
  });

  it("rejects an empty scene and invalid export options", async () => {
    await expect(exportSketch({ elements: [] })).rejects.toThrow("Draw something");
    await expect(exportSketch({ elements: [element()] }, { pixelRatio: 0 })).rejects.toThrow(
      "pixel ratio",
    );
    await expect(exportSketch({ elements: [element()] }, { padding: -1 })).rejects.toThrow(
      "padding",
    );
  });

  it("rejects unavailable canvas contexts and failed PNG encoding", async () => {
    vi.stubGlobal("document", { createElement: () => ({ getContext: () => null }) });
    await expect(exportSketch({ elements: [element()] })).rejects.toThrow("create a canvas");
    const canvas = installCanvas();
    vi.spyOn(canvas, "toBlob").mockImplementation((callback) => callback(null));
    await expect(exportSketch({ elements: [element()] })).rejects.toThrow("export your sketch");
  });
});
