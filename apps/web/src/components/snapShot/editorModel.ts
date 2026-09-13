import {
  SNAP_SHOT_EXPORT_MAX_BYTES,
  SNAP_SHOT_EXPORT_MAX_DIMENSION,
  SNAP_SHOT_EXPORT_MAX_PIXELS,
  type SnapShotSource,
} from "@spiritdevs/contracts";

export type Point = { x: number; y: number };
export type Rect = Point & { width: number; height: number };
export type AnnotationTool =
  | "rectangle"
  | "ellipse"
  | "arrow"
  | "text"
  | "pen"
  | "highlight"
  | "number";
export type EditorTool = AnnotationTool | "select" | "pan" | "crop";
export type Annotation = {
  id: string;
  tool: AnnotationTool;
  points: Point[];
  color: string;
  width: number;
  text?: string;
  fontSize: number;
};
export type EditorDocument = { annotations: Annotation[]; crop: Rect };

export function rectangleBetween(a: Point, b: Point): Rect {
  return {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
}

export function annotationBounds(annotation: Annotation): Rect {
  const start = annotation.points[0]!;
  if (annotation.tool === "text") {
    const lines = (annotation.text || "Text").split("\n");
    return {
      ...start,
      width:
        Math.max(...lines.map((line) => line.length), 1) * annotation.fontSize * 0.65 +
        annotation.fontSize * 0.6,
      height: lines.length * annotation.fontSize * 1.25 + annotation.fontSize * 0.6,
    };
  }
  if (annotation.tool === "number") {
    const radius = annotation.fontSize * 0.85;
    return { x: start.x - radius, y: start.y - radius, width: radius * 2, height: radius * 2 };
  }
  let left = start.x;
  let right = start.x;
  let top = start.y;
  let bottom = start.y;
  for (const point of annotation.points) {
    left = Math.min(left, point.x);
    right = Math.max(right, point.x);
    top = Math.min(top, point.y);
    bottom = Math.max(bottom, point.y);
  }
  return rectangleBetween({ x: left, y: top }, { x: right, y: bottom });
}

export function containsPoint(bounds: Rect, point: Point, padding = 0): boolean {
  return (
    point.x >= bounds.x - padding &&
    point.x <= bounds.x + bounds.width + padding &&
    point.y >= bounds.y - padding &&
    point.y <= bounds.y + bounds.height + padding
  );
}

export function moveAnnotation(annotation: Annotation, delta: Point): Annotation {
  return {
    ...annotation,
    points: annotation.points.map((point) => ({ x: point.x + delta.x, y: point.y + delta.y })),
  };
}

/** Transform from the gesture's original bounds, so pointer updates never accumulate rounding. */
export function resizeAnnotation(annotation: Annotation, target: Rect): Annotation {
  const bounds = annotationBounds(annotation);
  const scaleX = target.width / Math.max(bounds.width, 1);
  const scaleY = target.height / Math.max(bounds.height, 1);
  return {
    ...annotation,
    points: annotation.points.map((point) => ({
      x: target.x + (point.x - bounds.x) * scaleX,
      y: target.y + (point.y - bounds.y) * scaleY,
    })),
    fontSize:
      annotation.tool === "text" || annotation.tool === "number"
        ? Math.max(8, annotation.fontSize * Math.min(scaleX, scaleY))
        : annotation.fontSize,
  };
}

export function boundedCrop(crop: Rect, image: Rect): Rect {
  const x = Math.max(image.x, Math.min(image.x + image.width - 1, Math.round(crop.x)));
  const y = Math.max(image.y, Math.min(image.y + image.height - 1, Math.round(crop.y)));
  return {
    x,
    y,
    width: Math.max(1, Math.min(image.x + image.width, Math.round(crop.x + crop.width)) - x),
    height: Math.max(1, Math.min(image.y + image.height, Math.round(crop.y + crop.height)) - y),
  };
}

/** Crops cannot retain text from outside the image or coordinates in the original image. */
export function sourceAfterCrop(
  source: SnapShotSource | undefined,
  crop: Rect,
  originalSize: { width: number; height: number },
): SnapShotSource | undefined {
  if (
    !source ||
    (crop.x === 0 &&
      crop.y === 0 &&
      crop.width === originalSize.width &&
      crop.height === originalSize.height)
  ) {
    return source;
  }
  const { accessibility: _accessibility, accessibleText: _accessibleText, ...provenance } = source;
  const captureBounds = source.captureBounds;
  return {
    ...provenance,
    captureType: "region",
    ...(captureBounds
      ? {
          captureBounds: {
            x: captureBounds.x + (crop.x / originalSize.width) * captureBounds.width,
            y: captureBounds.y + (crop.y / originalSize.height) * captureBounds.height,
            width: Math.max(1, Math.round((crop.width / originalSize.width) * captureBounds.width)),
            height: Math.max(
              1,
              Math.round((crop.height / originalSize.height) * captureBounds.height),
            ),
          },
        }
      : {}),
  };
}

/** The middle handle sits on the curve, rather than at its off-curve control point. */
export function arrowHandles(annotation: Annotation): Point[] {
  const start = annotation.points[0]!;
  const end = annotation.points.at(-1)!;
  const control =
    annotation.points.length === 3
      ? annotation.points[1]!
      : {
          x: (start.x + end.x) / 2,
          y: (start.y + end.y) / 2,
        };
  return [
    start,
    { x: (start.x + 2 * control.x + end.x) / 4, y: (start.y + 2 * control.y + end.y) / 4 },
    end,
  ];
}

export function reshapeArrow(annotation: Annotation, handle: number, point: Point): Annotation {
  const start = annotation.points[0]!;
  const end = annotation.points.at(-1)!;
  if (handle === 1)
    return {
      ...annotation,
      points: [
        start,
        {
          x: 2 * point.x - (start.x + end.x) / 2,
          y: 2 * point.y - (start.y + end.y) / 2,
        },
        end,
      ],
    };
  return {
    ...annotation,
    points: annotation.points.map((value, index) =>
      index === (handle === 0 ? 0 : annotation.points.length - 1) ? point : value,
    ),
  };
}

export function arrowPath(annotation: Annotation): string {
  const start = annotation.points[0]!;
  const end = annotation.points.at(-1)!;
  const control = annotation.points.length === 3 ? annotation.points[1]! : null;
  return (
    `M ${start.x} ${start.y} ` +
    (control ? `Q ${control.x} ${control.y} ${end.x} ${end.y}` : `L ${end.x} ${end.y}`)
  );
}

export function arrowHead(annotation: Annotation): Point[] {
  const start = annotation.points.at(-2)!;
  const end = annotation.points.at(-1)!;
  const angle = Math.atan2(end.y - start.y, end.x - start.x);
  const length = Math.max(annotation.width * 8, 28);
  return [
    {
      x: end.x - length * Math.cos(angle - Math.PI / 6),
      y: end.y - length * Math.sin(angle - Math.PI / 6),
    },
    end,
    {
      x: end.x - length * Math.cos(angle + Math.PI / 6),
      y: end.y - length * Math.sin(angle + Math.PI / 6),
    },
  ];
}

export function drawAnnotation(context: CanvasRenderingContext2D, annotation: Annotation): void {
  const start = annotation.points[0]!;
  const bounds = annotationBounds(annotation);
  context.save();
  context.strokeStyle = annotation.color;
  context.fillStyle = annotation.color;
  context.lineWidth = annotation.width;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.beginPath();
  if (annotation.tool === "rectangle") {
    context.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
  } else if (annotation.tool === "ellipse") {
    context.ellipse(
      bounds.x + bounds.width / 2,
      bounds.y + bounds.height / 2,
      bounds.width / 2,
      bounds.height / 2,
      0,
      0,
      Math.PI * 2,
    );
    context.stroke();
  } else if (annotation.tool === "text") {
    context.font = `600 ${annotation.fontSize}px Arial, sans-serif`;
    context.textBaseline = "top";
    context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
    context.fillStyle = "#ffffff";
    const padding = annotation.fontSize * 0.3;
    (annotation.text || "").split("\n").forEach((line, index) => {
      context.fillText(
        line,
        start.x + padding,
        start.y + padding + index * annotation.fontSize * 1.25,
      );
    });
  } else if (annotation.tool === "number") {
    context.arc(start.x, start.y, annotation.fontSize * 0.85, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = "#ffffff";
    context.font = `600 ${annotation.fontSize}px Arial, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(annotation.text || "1", start.x, start.y);
  } else {
    if (annotation.tool === "highlight") {
      context.globalAlpha = 0.3;
      context.lineWidth = annotation.width * 6;
      context.lineCap = "square";
    }
    context.moveTo(start.x, start.y);
    if (annotation.tool === "arrow") {
      context.lineWidth = annotation.width * 2.5;
      const end = annotation.points.at(-1)!;
      if (annotation.points.length === 3) {
        const control = annotation.points[1]!;
        context.quadraticCurveTo(control.x, control.y, end.x, end.y);
      } else context.lineTo(end.x, end.y);
    } else for (const point of annotation.points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
    if (annotation.tool === "arrow") {
      const head = arrowHead(annotation);
      context.beginPath();
      context.moveTo(head[0]!.x, head[0]!.y);
      context.lineTo(head[1]!.x, head[1]!.y);
      context.lineTo(head[2]!.x, head[2]!.y);
      context.closePath();
      context.fill();
    }
  }
  context.restore();
}

/** Keep original resolution unless the PNG exceeds the native export limits. */
export function exportSnapShot(image: HTMLImageElement, document: EditorDocument) {
  const canvas = window.document.createElement("canvas");
  const crop = document.crop;
  const initialScale = Math.min(
    1,
    SNAP_SHOT_EXPORT_MAX_DIMENSION / Math.max(crop.width, crop.height),
    Math.sqrt(SNAP_SHOT_EXPORT_MAX_PIXELS / (crop.width * crop.height)),
  );
  let width = Math.max(1, Math.floor(crop.width * initialScale));
  let height = Math.max(1, Math.floor(crop.height * initialScale));
  for (;;) {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The image editor could not create an image. Please try again.");
    context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
    context.scale(width / crop.width, height / crop.height);
    context.translate(-crop.x, -crop.y);
    for (const annotation of document.annotations) drawAnnotation(context, annotation);
    const dataUrl = canvas.toDataURL("image/png");
    if (!dataUrl.startsWith("data:image/png;base64,"))
      throw new Error("This image is too large to export. Crop it and try again.");
    const padding = dataUrl.endsWith("==") ? 2 : dataUrl.endsWith("=") ? 1 : 0;
    const bytes = ((dataUrl.length - "data:image/png;base64,".length) / 4) * 3 - padding;
    if (bytes <= SNAP_SHOT_EXPORT_MAX_BYTES) return { dataUrl, imageSize: { width, height } };
    if (width === 1 && height === 1)
      throw new Error("This image is too large to export. Crop it and try again.");
    // PNG size depends on content. Recheck each encoding and redraw from original pixels.
    const scale = Math.min(0.8, Math.sqrt(SNAP_SHOT_EXPORT_MAX_BYTES / bytes) * 0.95);
    width = Math.max(1, Math.floor(width * scale));
    height = Math.max(1, Math.floor(height * scale));
  }
}
