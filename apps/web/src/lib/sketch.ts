import * as Schema from "effect/Schema";

export const SketchElementKind = Schema.Literals([
  "pen",
  "rectangle",
  "ellipse",
  "line",
  "arrow",
  "text",
]);
export type SketchElementKind = typeof SketchElementKind.Type;
export const SketchPoint = Schema.Struct({
  x: Schema.Number.check(Schema.isFinite()),
  y: Schema.Number.check(Schema.isFinite()),
});
export type SketchPoint = typeof SketchPoint.Type;
export const SketchElement = Schema.Struct({
  id: Schema.String,
  kind: SketchElementKind,
  points: Schema.mutable(Schema.Array(SketchPoint)).check(Schema.isMinLength(1)),
  color: Schema.String.check(Schema.isPattern(/^#[\da-f]{6}$/i)),
  size: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  text: Schema.optionalKey(Schema.String),
});
export type SketchElement = typeof SketchElement.Type;
// Mutable arrays let a scene sit inside the draft store's DeepMutable persisted state.
export const SketchScene = Schema.Struct({ elements: Schema.mutable(Schema.Array(SketchElement)) });
export type SketchScene = typeof SketchScene.Type;
export type SketchRect = { x: number; y: number; width: number; height: number };

export const SKETCH_FONT_FAMILY = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
export const SKETCH_FONT_WEIGHT = 500;
export const SKETCH_TEXT_LINE_HEIGHT = 1.25;

export function sketchFontSize(size: number): number {
  return 16 + ((size - 2) * 40) / 22;
}

function sketchFont(size: number) {
  return `${SKETCH_FONT_WEIGHT} ${sketchFontSize(size)}px ${SKETCH_FONT_FAMILY}`;
}

function rectangleBetween(a: SketchPoint, b: SketchPoint): SketchRect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

function rectangleRadius(element: SketchElement, rect: SketchRect) {
  return Math.min(element.size * 1.5 + 4, rect.width / 2, rect.height / 2);
}

function arrowHead(element: SketchElement) {
  const start = element.points[0]!;
  const end = element.points.at(-1)!;
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const length = Math.max(element.size * 4, 14);
  return [
    {
      x: end.x - length * Math.cos(angle - Math.PI / 6),
      y: end.y - length * Math.sin(angle - Math.PI / 6),
    },
    {
      x: end.x - length * Math.cos(angle + Math.PI / 6),
      y: end.y - length * Math.sin(angle + Math.PI / 6),
    },
  ] as const;
}

type TextMeasurer = Pick<CanvasRenderingContext2D, "font" | "textBaseline" | "measureText">;
let textMeasurer: TextMeasurer | null = null;

function getTextMeasurer() {
  if (typeof document === "undefined") return null;
  if (!textMeasurer) {
    textMeasurer = document.createElement("canvas").getContext("2d");
  }
  return textMeasurer;
}

/** Visual bounds used for cropping and selecting, including strokes and arrowheads. */
export function sketchElementBounds(element: SketchElement): SketchRect {
  const start = element.points[0]!;
  if (element.kind === "text") {
    const fontSize = sketchFontSize(element.size);
    const lines = (element.text ?? "").split("\n");
    const context = getTextMeasurer();
    if (context) {
      context.font = sketchFont(element.size);
      context.textBaseline = "top";
    }
    let left = 0;
    let right = 0;
    let top = 0;
    let bottom = fontSize + (lines.length - 1) * fontSize * SKETCH_TEXT_LINE_HEIGHT;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!;
      if (!context) {
        right = Math.max(right, Array.from(line).length * fontSize * 0.6);
        continue;
      }
      const metrics = context.measureText(line);
      const y = index * fontSize * SKETCH_TEXT_LINE_HEIGHT;
      left = Math.min(left, -(metrics.actualBoundingBoxLeft || 0));
      right = Math.max(right, metrics.width, metrics.actualBoundingBoxRight || 0);
      top = Math.min(top, y - (metrics.actualBoundingBoxAscent || 0));
      bottom = Math.max(bottom, y + (metrics.actualBoundingBoxDescent || 0));
    }
    return { x: start.x + left, y: start.y + top, width: right - left, height: bottom - top };
  }
  let left = start.x;
  let right = start.x;
  let top = start.y;
  let bottom = start.y;
  const points = element.kind === "pen" ? element.points : [start, element.points.at(-1)!];
  for (const point of points) {
    left = Math.min(left, point.x);
    right = Math.max(right, point.x);
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
  }
  if (element.kind === "arrow") {
    for (const point of arrowHead(element)) {
      left = Math.min(left, point.x);
      right = Math.max(right, point.x);
      top = Math.min(top, point.y);
      bottom = Math.max(bottom, point.y);
    }
  }
  const padding = element.size / 2;
  return {
    x: left - padding,
    y: top - padding,
    width: right - left + element.size,
    height: bottom - top + element.size,
  };
}

export function sketchSceneBounds(elements: ReadonlyArray<SketchElement>): SketchRect | null {
  if (elements.length === 0) return null;
  const first = sketchElementBounds(elements[0]!);
  let left = first.x;
  let top = first.y;
  let right = left + first.width;
  let bottom = top + first.height;
  for (let index = 1; index < elements.length; index++) {
    const bounds = sketchElementBounds(elements[index]!);
    left = Math.min(left, bounds.x);
    top = Math.min(top, bounds.y);
    right = Math.max(right, bounds.x + bounds.width);
    bottom = Math.max(bottom, bounds.y + bounds.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function segmentDistance(point: SketchPoint, start: SketchPoint, end: SketchPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const squaredLength = dx * dx + dy * dy;
  const t =
    squaredLength === 0
      ? 0
      : Math.max(
          0,
          Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / squaredLength),
        );
  return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
}

/** Closest ellipse point via a bounded root solve; radial distance is wrong on narrow ellipses. */
function ellipseDistance(point: SketchPoint, rect: SketchRect) {
  let a = rect.width / 2;
  let b = rect.height / 2;
  let x = Math.abs(point.x - rect.x - a);
  let y = Math.abs(point.y - rect.y - b);
  if (a < b) {
    [a, b] = [b, a];
    [x, y] = [y, x];
  }
  if (a === b) return Math.abs(Math.hypot(x, y) - a);
  if (x === 0) return Math.abs(y - b);
  if (y === 0) {
    const cos = Math.min(1, (a * x) / (a * a - b * b));
    return Math.hypot(a * cos - x, b * Math.sqrt(1 - cos * cos));
  }
  const aa = a * a;
  const bb = b * b;
  let low = b * y - bb;
  let high = Math.hypot(a * x, b * y);
  for (let index = 0; index < 48; index++) {
    const t = (low + high) / 2;
    const u = (a * x) / (t + aa);
    const v = (b * y) / (t + bb);
    if (u * u + v * v > 1) low = t;
    else high = t;
  }
  const t = (low + high) / 2;
  return Math.hypot((aa * x) / (t + aa) - x, (bb * y) / (t + bb) - y);
}

/** Object erasing tests drawn outlines, so empty shape interiors do not erase the object. */
export function sketchElementTouches(
  element: SketchElement,
  point: SketchPoint,
  radius: number,
): boolean {
  const start = element.points[0]!;
  const end = element.points.at(-1)!;
  const reach = Math.max(0, radius) + element.size / 2;
  if (element.kind === "text") {
    const bounds = sketchElementBounds(element);
    const dx = Math.max(bounds.x - point.x, 0, point.x - bounds.x - bounds.width);
    const dy = Math.max(bounds.y - point.y, 0, point.y - bounds.y - bounds.height);
    return Math.hypot(dx, dy) <= Math.max(0, radius);
  }
  if (element.kind === "rectangle" || element.kind === "ellipse") {
    const rect = rectangleBetween(start, end);
    if (rect.width === 0 || rect.height === 0) return segmentDistance(point, start, end) <= reach;
    if (element.kind === "ellipse") return ellipseDistance(point, rect) <= reach;
    const corner = rectangleRadius(element, rect);
    const dx = Math.abs(point.x - rect.x - rect.width / 2) - rect.width / 2 + corner;
    const dy = Math.abs(point.y - rect.y - rect.height / 2) - rect.height / 2 + corner;
    const distance =
      Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - corner;
    return Math.abs(distance) <= reach;
  }
  if (element.kind === "pen") {
    if (element.points.length === 1) return segmentDistance(point, start, start) <= reach;
    for (let index = 1; index < element.points.length; index++) {
      if (segmentDistance(point, element.points[index - 1]!, element.points[index]!) <= reach)
        return true;
    }
    return false;
  }
  if (segmentDistance(point, start, end) <= reach) return true;
  if (element.kind === "arrow") {
    const head = arrowHead(element);
    return (
      segmentDistance(point, head[0], end) <= reach || segmentDistance(point, head[1], end) <= reach
    );
  }
  return false;
}

export function moveSketchElement(element: SketchElement, delta: SketchPoint): SketchElement {
  return {
    ...element,
    points: element.points.map((point) => ({ x: point.x + delta.x, y: point.y + delta.y })),
  };
}

/** Shared renderer for the live canvas and PNG export, preserving the caller's transform. */
export function drawSketchElement(context: CanvasRenderingContext2D, element: SketchElement): void {
  const start = element.points[0]!;
  const end = element.points.at(-1)!;
  context.save();
  context.strokeStyle = element.color;
  context.fillStyle = element.color;
  context.lineWidth = element.size;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  if (element.kind === "text") {
    const fontSize = sketchFontSize(element.size);
    context.font = sketchFont(element.size);
    context.textBaseline = "top";
    context.textAlign = "left";
    const lines = (element.text ?? "").split("\n");
    for (let index = 0; index < lines.length; index++) {
      context.fillText(
        lines[index]!,
        start.x,
        start.y + index * fontSize * SKETCH_TEXT_LINE_HEIGHT,
      );
    }
  } else if (element.kind === "rectangle" || element.kind === "ellipse") {
    const bounds = rectangleBetween(start, end);
    if (bounds.width === 0 || bounds.height === 0) {
      context.moveTo(start.x, start.y);
      context.lineTo(end.x, end.y);
    } else if (element.kind === "rectangle") {
      context.roundRect(
        bounds.x,
        bounds.y,
        bounds.width,
        bounds.height,
        rectangleRadius(element, bounds),
      );
    } else {
      context.ellipse(
        bounds.x + bounds.width / 2,
        bounds.y + bounds.height / 2,
        bounds.width / 2,
        bounds.height / 2,
        0,
        0,
        Math.PI * 2,
      );
    }
    context.stroke();
  } else if (element.kind === "pen") {
    let hasLength = false;
    for (let index = 1; index < element.points.length; index++) {
      const point = element.points[index]!;
      if (point.x !== start.x || point.y !== start.y) {
        hasLength = true;
        break;
      }
    }
    if (!hasLength) {
      context.arc(start.x, start.y, element.size / 2, 0, Math.PI * 2);
      context.fill();
    } else {
      context.moveTo(start.x, start.y);
      for (let index = 1; index < element.points.length - 1; index++) {
        const point = element.points[index]!;
        const next = element.points[index + 1]!;
        context.quadraticCurveTo(point.x, point.y, (point.x + next.x) / 2, (point.y + next.y) / 2);
      }
      context.lineTo(end.x, end.y);
      context.stroke();
    }
  } else {
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    if (element.kind === "arrow") {
      const head = arrowHead(element);
      context.moveTo(head[0].x, head[0].y);
      context.lineTo(end.x, end.y);
      context.lineTo(head[1].x, head[1].y);
    }
    context.stroke();
  }
  context.restore();
}

export function drawSketchScene(
  context: CanvasRenderingContext2D,
  elements: ReadonlyArray<SketchElement>,
): void {
  for (const element of elements) drawSketchElement(context, element);
}

/** Crop to the scene's ink and pad on white; the output scale is capped at 4096 px per side. */
export async function exportSketch(
  scene: SketchScene,
  options?: { padding?: number; pixelRatio?: number },
): Promise<{ blob: Blob; width: number; height: number }> {
  const bounds = sketchSceneBounds(scene.elements);
  if (!bounds) throw new Error("Draw something before exporting your sketch.");
  const padding = options?.padding ?? 32;
  const pixelRatio = options?.pixelRatio ?? 2;
  if (!Number.isFinite(padding) || padding < 0 || !Number.isFinite(pixelRatio) || pixelRatio <= 0) {
    throw new Error(
      "Sketch padding and pixel ratio must be finite and non-negative, with a positive pixel ratio.",
    );
  }
  const sceneWidth = Math.max(1, bounds.width + padding * 2);
  const sceneHeight = Math.max(1, bounds.height + padding * 2);
  const scale = Math.min(pixelRatio, 4096 / Math.max(sceneWidth, sceneHeight));
  const width = Math.max(1, Math.min(4096, Math.ceil(sceneWidth * scale)));
  const height = Math.max(1, Math.min(4096, Math.ceil(sceneHeight * scale)));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create a canvas for your sketch.");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.scale(scale, scale);
  context.translate(padding - bounds.x, padding - bounds.y);
  drawSketchScene(context, scene.elements);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (result) => (result ? resolve(result) : reject(new Error("Could not export your sketch."))),
      "image/png",
    );
  });
  return { blob, width, height };
}

const isSketchScene = Schema.is(SketchScene);

/** Validates untrusted persisted data; null when invalid. */
export function decodeSketchScene(value: unknown): SketchScene | null {
  return isSketchScene(value) ? value : null;
}
