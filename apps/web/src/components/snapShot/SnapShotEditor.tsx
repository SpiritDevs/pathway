import { resizeSnapShotSource } from "../../lib/snapShotSource";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { SnapShotSource } from "@spiritdevs/contracts";
import {
  ArrowUpRightIcon,
  CheckIcon,
  CircleIcon,
  CirclePlusIcon,
  CopyIcon,
  CropIcon,
  DownloadIcon,
  HandIcon,
  HighlighterIcon,
  MessageSquarePlusIcon,
  MousePointer2Icon,
  PencilIcon,
  Redo2Icon,
  RotateCcwIcon,
  SquareIcon,
  Trash2Icon,
  TypeIcon,
  Undo2Icon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { randomUUID } from "../../lib/utils";

import {
  annotationBounds,
  arrowHead,
  arrowHandles,
  arrowPath,
  reshapeArrow,
  boundedCrop,
  containsPoint,
  exportSnapShot,
  moveAnnotation,
  rectangleBetween,
  resizeAnnotation,
  sourceAfterCrop,
  type Annotation,
  type EditorDocument,
  type EditorTool,
  type Point,
  type Rect,
} from "./editorModel";
import "./SnapShotEditor.css";

export type SnapShotEditorAction = "copy" | "chat" | "download";
export type SnapShotEditorResult = { dataUrl: string; name: string; source?: SnapShotSource };
export type SnapShotEditorProps = {
  image: SnapShotEditorResult & { id: string };
  onAction: (action: SnapShotEditorAction, result: SnapShotEditorResult) => Promise<void>;
  onClose: () => void;
};

const TOOLS: { tool: EditorTool; label: string; key: string; icon: LucideIcon }[] = [
  { tool: "select", label: "Select and move", key: "V", icon: MousePointer2Icon },
  { tool: "pan", label: "Pan", key: "H", icon: HandIcon },
  { tool: "text", label: "Text", key: "T", icon: TypeIcon },
  { tool: "rectangle", label: "Rectangle", key: "R", icon: SquareIcon },
  { tool: "ellipse", label: "Ellipse", key: "O", icon: CircleIcon },
  { tool: "arrow", label: "Arrow", key: "A", icon: ArrowUpRightIcon },
  { tool: "pen", label: "Freehand", key: "P", icon: PencilIcon },
  { tool: "highlight", label: "Highlighter", key: "M", icon: HighlighterIcon },
  { tool: "number", label: "Numbered callout", key: "N", icon: CirclePlusIcon },
  { tool: "crop", label: "Crop", key: "C", icon: CropIcon },
];
const COLORS = [
  "#ed3b32",
  "#ff9500",
  "#ffcc00",
  "#34c759",
  "#007aff",
  "#af52de",
  "#ffffff",
  "#222222",
];
const EMPTY_DOCUMENT: EditorDocument = {
  annotations: [],
  crop: { x: 0, y: 0, width: 1, height: 1 },
};
type Gesture =
  | { kind: "arrow-handle"; handle: number; original: EditorDocument; annotation: Annotation }
  | { kind: "draw"; start: Point; original: EditorDocument; annotation: Annotation }
  | { kind: "move"; start: Point; original: EditorDocument; annotation: Annotation }
  | {
      kind: "resize";
      start: Point;
      anchor: Point;
      original: EditorDocument;
      annotation: Annotation;
    }
  | { kind: "crop"; start: Point; original: EditorDocument }
  | { kind: "pan"; start: Point; left: number; top: number };

function ToolButton({
  label,
  icon: Icon,
  selected,
  disabled,
  onClick,
  className = "",
}: {
  label: string;
  icon: LucideIcon;
  selected?: boolean;
  disabled?: boolean;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`shot-editor-button ${className}`}
      aria-label={label}
      aria-pressed={selected}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={22} strokeWidth={1.65} aria-hidden="true" />
    </button>
  );
}

function AnnotationShape({ annotation }: { annotation: Annotation }) {
  const bounds = annotationBounds(annotation);
  const start = annotation.points[0]!;
  const points = annotation.points.map((point) => `${point.x},${point.y}`).join(" ");
  const style = {
    stroke: annotation.color,
    strokeWidth: annotation.width,
    fill: "none",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (annotation.tool) {
    case "rectangle":
      return <rect {...bounds} {...style} />;
    case "ellipse":
      return (
        <ellipse
          cx={bounds.x + bounds.width / 2}
          cy={bounds.y + bounds.height / 2}
          rx={bounds.width / 2}
          ry={bounds.height / 2}
          {...style}
        />
      );
    case "text":
      return (
        <g>
          <rect {...bounds} fill={annotation.color} />
          <text
            x={start.x + annotation.fontSize * 0.3}
            y={start.y + annotation.fontSize * 0.3}
            fill="white"
            fontFamily="Arial, sans-serif"
            fontSize={annotation.fontSize}
            fontWeight="600"
            dominantBaseline="text-before-edge"
          >
            {Array.from((annotation.text || "").matchAll(/^.*$/gm)).map((line, index) => (
              <tspan
                key={line.index}
                x={start.x + annotation.fontSize * 0.3}
                dy={index === 0 ? 0 : annotation.fontSize * 1.25}
              >
                {line[0] || "\u00a0"}
              </tspan>
            ))}
          </text>
        </g>
      );
    case "number":
      return (
        <g>
          <circle
            cx={start.x}
            cy={start.y}
            r={annotation.fontSize * 0.85}
            fill={annotation.color}
          />
          <text
            x={start.x}
            y={start.y}
            fill="white"
            fontFamily="Arial, sans-serif"
            fontSize={annotation.fontSize}
            fontWeight="600"
            textAnchor="middle"
            dominantBaseline="central"
          >
            {annotation.text}
          </text>
        </g>
      );
    case "arrow":
      return (
        <g {...style}>
          <path d={arrowPath(annotation)} strokeWidth={annotation.width * 2.5} />
          <polygon
            fill={annotation.color}
            stroke="none"
            points={arrowHead(annotation)
              .map((point) => `${point.x},${point.y}`)
              .join(" ")}
          />
        </g>
      );
    case "highlight":
      return (
        <polyline
          points={points}
          {...style}
          opacity={0.3}
          strokeWidth={annotation.width * 6}
          strokeLinecap="square"
        />
      );
    case "pen":
      return <polyline points={points} {...style} />;
  }
}

function isTextInput(target: EventTarget | null) {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest("input, textarea, select, [contenteditable=true]"))
  );
}

/** Captured pixels and vector annotations stay separate until an output action flattens them. */
export function SnapShotEditor({ image, onAction, onClose }: SnapShotEditorProps) {
  const [document, setDocument] = useState<EditorDocument>(EMPTY_DOCUMENT);
  const documentRef = useRef(document);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const workspaceRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const undoRef = useRef<EditorDocument[]>([]);
  const redoRef = useRef<EditorDocument[]>([]);
  const [historyRevision, setHistoryRevision] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [tool, setTool] = useState<EditorTool>("select");
  const [color, setColor] = useState("#ed3b32");
  const [strokeWidth, setStrokeWidth] = useState(4);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editing, setEditing] = useState<Annotation | null>(null);
  const [editingText, setEditingText] = useState("");
  const [cropSelection, setCropSelection] = useState<Rect | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [workspaceSize, setWorkspaceSize] = useState({ width: 900, height: 600 });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<SnapShotEditorAction | null>(null);
  const fitZoom = Math.min(
    (workspaceSize.width - 48) / document.crop.width,
    (workspaceSize.height - 48) / document.crop.height,
    1,
  );
  const scale = Math.max(0.025, zoom ?? fitZoom);
  const selected = document.annotations.find((annotation) => annotation.id === selectedId);
  const selectionBounds = selected ? annotationBounds(selected) : null;

  function preview(next: EditorDocument) {
    documentRef.current = next;
    setDocument(next);
  }

  function commit(next: EditorDocument, previous = documentRef.current) {
    undoRef.current = [...undoRef.current.slice(-79), previous];
    redoRef.current = [];
    preview(next);
    setHistoryRevision((revision) => revision + 1);
  }

  function undo() {
    const previous = undoRef.current.pop();
    if (!previous) return;
    redoRef.current.push(documentRef.current);
    preview(previous);
    setSelectedId(null);
    setCropSelection(null);
    setEditing(null);
    setHistoryRevision((revision) => revision + 1);
  }

  function redo() {
    const next = redoRef.current.pop();
    if (!next) return;
    undoRef.current.push(documentRef.current);
    preview(next);
    setSelectedId(null);
    setCropSelection(null);
    setEditing(null);
    setHistoryRevision((revision) => revision + 1);
  }

  function finishText() {
    if (!editing) return;
    const current = documentRef.current;
    const previous = current.annotations.find((annotation) => annotation.id === editing.id);
    const remaining = current.annotations.filter((annotation) => annotation.id !== editing.id);
    if (previous?.text === editingText) {
      setSelectedId(editing.id);
      setEditing(null);
      return;
    }
    if (editingText.trim()) {
      const annotation = { ...editing, text: editingText };
      commit({
        ...current,
        annotations: previous
          ? current.annotations.map((item) => (item.id === editing.id ? annotation : item))
          : [...remaining, annotation],
      });
      setSelectedId(editing.id);
    } else if (previous) {
      commit({ ...current, annotations: remaining });
    }
    setEditing(null);
  }

  function chooseTool(next: EditorTool) {
    finishText();
    setTool(next);
    setCropSelection(null);
    if (next !== "select") setSelectedId(null);
  }

  function updateStyle(nextColor: string, nextWidth: number) {
    setColor(nextColor);
    setStrokeWidth(nextWidth);
    if (selected)
      commit({
        ...documentRef.current,
        annotations: documentRef.current.annotations.map((annotation) =>
          annotation.id === selected.id
            ? { ...annotation, color: nextColor, width: nextWidth }
            : annotation,
        ),
      });
  }

  function removeSelected() {
    if (!selectedId) return;
    commit({
      ...documentRef.current,
      annotations: documentRef.current.annotations.filter(
        (annotation) => annotation.id !== selectedId,
      ),
    });
    setSelectedId(null);
  }

  function applyCrop() {
    if (!cropSelection) return;
    commit({ ...documentRef.current, crop: boundedCrop(cropSelection, documentRef.current.crop) });
    setCropSelection(null);
    setSelectedId(null);
    setTool("select");
    setZoom(null);
  }

  async function act(action: SnapShotEditorAction) {
    if (busy || !imageRef.current) return;
    finishText();
    if (cropSelection) applyCrop();
    setBusy(action);
    setError(null);
    try {
      const current = documentRef.current;
      const { dataUrl, imageSize } = exportSnapShot(imageRef.current, current);
      const source = sourceAfterCrop(image.source, current.crop, {
        width: imageRef.current.naturalWidth,
        height: imageRef.current.naturalHeight,
      });
      await onAction(action, {
        dataUrl,
        name: image.name.replace(/\.[^.]+$/, "") + ".png",
        ...(source ? { source: resizeSnapShotSource(source, imageSize) } : {}),
      });
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The image could not be saved. Please try again.",
      );
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    let cancelled = false;
    const bitmap = new Image();
    bitmap.addEventListener("load", () => {
      if (cancelled) return;
      imageRef.current = bitmap;
      const initial = {
        annotations: [],
        crop: { x: 0, y: 0, width: bitmap.naturalWidth, height: bitmap.naturalHeight },
      };
      documentRef.current = initial;
      setDocument(initial);
      setLoaded(true);
    });
    bitmap.addEventListener("error", () => {
      if (!cancelled)
        setError("This capture could not be opened. Close the editor and try capturing again.");
    });
    bitmap.src = image.dataUrl;
    return () => {
      cancelled = true;
    };
  }, [image.dataUrl]);

  const observeWorkspace = useCallback((workspace: HTMLDivElement | null) => {
    workspaceRef.current = workspace;
    if (!workspace) return;
    setWorkspaceSize({ width: workspace.clientWidth, height: workspace.clientHeight });
    const observer = new ResizeObserver(([entry]) => {
      if (entry)
        setWorkspaceSize({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (editing) textRef.current?.focus();
  }, [editing]);

  useEffect(() => {
    if (loaded) stageRef.current?.focus({ preventScroll: true });
  }, [loaded]);

  function pointFromEvent(event: PointerEvent): Point {
    const bounds = stageRef.current!.getBoundingClientRect();
    return {
      x: document.crop.x + (event.clientX - bounds.left) / scale,
      y: document.crop.y + (event.clientY - bounds.top) / scale,
    };
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!loaded || busy || event.button !== 0 || isTextInput(event.target)) return;
    finishText();
    event.preventDefault();
    event.currentTarget.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFromEvent(event);
    const original = documentRef.current;
    if (tool === "pan" || event.altKey) {
      gestureRef.current = {
        kind: "pan",
        start: { x: event.clientX, y: event.clientY },
        left: workspaceRef.current!.scrollLeft,
        top: workspaceRef.current!.scrollTop,
      };
      return;
    }
    if (tool === "select") {
      if (selected?.tool === "arrow") {
        const handle = arrowHandles(selected).findIndex(
          (value) => Math.hypot(value.x - point.x, value.y - point.y) < 10 / scale,
        );
        if (handle !== -1) {
          gestureRef.current = { kind: "arrow-handle", handle, original, annotation: selected };
          return;
        }
      }
      if (selectionBounds && selected && selected.tool !== "arrow") {
        const corners = [
          { x: selectionBounds.x, y: selectionBounds.y },
          { x: selectionBounds.x + selectionBounds.width, y: selectionBounds.y },
          { x: selectionBounds.x, y: selectionBounds.y + selectionBounds.height },
          {
            x: selectionBounds.x + selectionBounds.width,
            y: selectionBounds.y + selectionBounds.height,
          },
        ];
        const cornerIndex = corners.findIndex(
          (corner) => Math.hypot(corner.x - point.x, corner.y - point.y) < 9 / scale,
        );
        if (cornerIndex !== -1) {
          gestureRef.current = {
            kind: "resize",
            start: point,
            anchor: corners[3 - cornerIndex]!,
            original,
            annotation: selected,
          };
          return;
        }
      }
      const hit = original.annotations
        .toReversed()
        .find((annotation) => containsPoint(annotationBounds(annotation), point, 7 / scale));
      setSelectedId(hit?.id ?? null);
      if (hit) {
        setColor(hit.color);
        setStrokeWidth(hit.width);
        gestureRef.current = { kind: "move", start: point, original, annotation: hit };
      }
      return;
    }
    setSelectedId(null);
    if (tool === "crop") {
      setCropSelection(null);
      gestureRef.current = { kind: "crop", start: point, original };
      return;
    }
    const annotation: Annotation = {
      id: randomUUID(),
      tool,
      points: [point, point],
      color,
      width: strokeWidth,
      fontSize: 26,
    };
    if (tool === "text") {
      setEditing(annotation);
      setEditingText("");
      return;
    }
    if (tool === "number") {
      annotation.text = String(
        original.annotations.reduce(
          (maximum, item) =>
            item.tool === "number" ? Math.max(maximum, Number(item.text) || 0) : maximum,
          0,
        ) + 1,
      );
      commit({ ...original, annotations: [...original.annotations, annotation] });
      return;
    }
    gestureRef.current = { kind: "draw", start: point, original, annotation };
    preview({ ...original, annotations: [...original.annotations, annotation] });
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture) return;
    if (gesture.kind === "pan") {
      workspaceRef.current!.scrollLeft = gesture.left - (event.clientX - gesture.start.x);
      workspaceRef.current!.scrollTop = gesture.top - (event.clientY - gesture.start.y);
      return;
    }
    const raw = pointFromEvent(event);
    const crop = documentRef.current.crop;
    const point = {
      x: Math.max(crop.x, Math.min(crop.x + crop.width, raw.x)),
      y: Math.max(crop.y, Math.min(crop.y + crop.height, raw.y)),
    };
    if (gesture.kind === "crop") {
      setCropSelection(rectangleBetween(gesture.start, point));
      return;
    }
    let annotation: Annotation;
    if (gesture.kind === "move") {
      annotation = moveAnnotation(gesture.annotation, {
        x: point.x - gesture.start.x,
        y: point.y - gesture.start.y,
      });
    } else if (gesture.kind === "arrow-handle") {
      annotation = reshapeArrow(gesture.annotation, gesture.handle, point);
    } else if (gesture.kind === "resize") {
      annotation = resizeAnnotation(gesture.annotation, rectangleBetween(gesture.anchor, point));
    } else {
      const freehand = gesture.annotation.tool === "pen" || gesture.annotation.tool === "highlight";
      if (freehand) {
        const previous = gesture.annotation.points.at(-1)!;
        if (Math.hypot(previous.x - point.x, previous.y - point.y) < 1.5 / scale) return;
        gesture.annotation = {
          ...gesture.annotation,
          points: [...gesture.annotation.points, point],
        };
      }
      let end = point;
      if (event.shiftKey && !freehand) {
        const dx = point.x - gesture.start.x;
        const dy = point.y - gesture.start.y;
        if (gesture.annotation.tool === "arrow") {
          const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
          const distance = Math.hypot(dx, dy);
          end = {
            x: gesture.start.x + Math.cos(angle) * distance,
            y: gesture.start.y + Math.sin(angle) * distance,
          };
        } else {
          const side = Math.max(Math.abs(dx), Math.abs(dy));
          end = {
            x: gesture.start.x + (Math.sign(dx) || 1) * side,
            y: gesture.start.y + (Math.sign(dy) || 1) * side,
          };
        }
      }
      annotation = freehand
        ? gesture.annotation
        : { ...gesture.annotation, points: [gesture.start, end] };
    }
    preview({
      ...gesture.original,
      annotations:
        gesture.kind === "draw"
          ? [...gesture.original.annotations, annotation]
          : gesture.original.annotations.map((item) =>
              item.id === annotation.id ? annotation : item,
            ),
    });
  }

  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (!gesture || gesture.kind === "pan" || gesture.kind === "crop") return;
    const next = documentRef.current;
    if (next === gesture.original) return;
    const annotation = next.annotations.find((item) => item.id === gesture.annotation.id);
    if (gesture.kind === "draw" && annotation) {
      const bounds = annotationBounds(annotation);
      if (bounds.width + bounds.height < 2) {
        preview(gesture.original);
        return;
      }
    }
    commit(next, gesture.original);
    setSelectedId(gesture.kind === "draw" ? null : gesture.annotation.id);
  }

  function cancelGesture() {
    const gesture = gestureRef.current;
    if (gesture && gesture.kind !== "pan") preview(gesture.original);
    gestureRef.current = null;
    setCropSelection(null);
  }

  function keyDown(event: KeyboardEvent) {
    event.stopPropagation();
    if (busy) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (isTextInput(event.target)) return;
    const key = event.key.toLowerCase();
    const command = event.metaKey || event.ctrlKey;
    if (
      key === "escape" &&
      (gestureRef.current || cropSelection || selectedId || tool !== "select")
    ) {
      event.preventDefault();
      event.stopPropagation();
      cancelGesture();
      setSelectedId(null);
      setTool("select");
      return;
    }
    if (key === "escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (command && key === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (command && key === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if (command && key === "c") {
      event.preventDefault();
      void act("copy");
      return;
    }
    if (command && key === "s") {
      event.preventDefault();
      void act("download");
      return;
    }
    if (key === "enter") {
      if (event.target instanceof HTMLElement && event.target.closest("button")) return;
      event.preventDefault();
      if (cropSelection) applyCrop();
      else void act("chat");
      return;
    }
    if (key === "delete" || key === "backspace") {
      event.preventDefault();
      removeSelected();
      return;
    }
    if (command || event.altKey) return;
    if (selected && ["arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
      event.preventDefault();
      const step = event.shiftKey ? 10 : 1;
      const delta = {
        x: key === "arrowleft" ? -step : key === "arrowright" ? step : 0,
        y: key === "arrowup" ? -step : key === "arrowdown" ? step : 0,
      };
      commit({
        ...documentRef.current,
        annotations: documentRef.current.annotations.map((annotation) =>
          annotation.id === selected.id ? moveAnnotation(annotation, delta) : annotation,
        ),
      });
      return;
    }
    if (key === "+" || key === "=") {
      event.preventDefault();
      setZoom(Math.min(4, scale * 1.25));
      return;
    }
    if (key === "-") {
      event.preventDefault();
      setZoom(Math.max(0.025, scale / 1.25));
      return;
    }
    if (key === "0") {
      event.preventDefault();
      setZoom(null);
      return;
    }
    const next = TOOLS.find((item) => item.key.toLowerCase() === key);
    if (next) {
      event.preventDefault();
      chooseTool(next.tool);
    }
  }

  const hint = cropSelection
    ? "Press Enter to crop · Escape to cancel"
    : tool === "select"
      ? selected?.tool === "arrow"
        ? "Drag endpoints to resize · Drag the middle dot to curve · Drag arrow to move"
        : "Select to move · Drag a corner to resize · Double-click text to edit"
      : tool === "pan"
        ? "Drag to pan · + / − to zoom · 0 to fit"
        : tool === "text"
          ? "Click to add text · ⌘ / Ctrl + Enter to finish"
          : tool === "crop"
            ? "Drag to select the area to keep"
            : "Drag to draw · Hold Shift for straight arrows and equal sides";

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="shot-editor-backdrop" />
        <DialogPrimitive.Popup className="shot-editor" onKeyDown={keyDown} initialFocus={stageRef}>
          <DialogPrimitive.Title className="shot-editor-sr-only">
            App Shot editor
          </DialogPrimitive.Title>
          <DialogPrimitive.Description className="shot-editor-sr-only">
            Annotate your capture, then copy it, save it to your chat draft, or download it. Each
            action closes the editor.
          </DialogPrimitive.Description>
          <header className="shot-editor-toolbar" aria-label="Image editor tools">
            <div className="shot-editor-window-controls">
              <button
                type="button"
                className="shot-editor-close"
                onClick={onClose}
                disabled={Boolean(busy)}
                title="Close editor"
                aria-label="Close editor"
              >
                <XIcon size={11} strokeWidth={2.5} />
              </button>
            </div>
            <div className="shot-editor-group" role="group" aria-label="Save image">
              <ToolButton
                label="Copy image and close (⌘/Ctrl+C)"
                icon={CopyIcon}
                onClick={() => void act("copy")}
                disabled={!loaded || Boolean(busy)}
              />
              <ToolButton
                label="Save to chat and close (Enter)"
                icon={MessageSquarePlusIcon}
                onClick={() => void act("chat")}
                disabled={!loaded || Boolean(busy)}
              />
              <ToolButton
                label="Download image and close (⌘/Ctrl+S)"
                icon={DownloadIcon}
                onClick={() => void act("download")}
                disabled={!loaded || Boolean(busy)}
              />
            </div>
            <div
              className="shot-editor-group shot-editor-tools"
              role="group"
              aria-label="Annotation tools"
            >
              {TOOLS.map(({ tool: next, label, key, icon }) => (
                <ToolButton
                  key={next}
                  label={`${label} (${key})`}
                  icon={icon}
                  selected={tool === next}
                  onClick={() => chooseTool(next)}
                  disabled={!loaded || Boolean(busy)}
                />
              ))}
            </div>
            <div
              className="shot-editor-group shot-editor-history"
              role="group"
              aria-label="Edit history"
              data-revision={historyRevision}
            >
              <ToolButton
                label="Undo (⌘/Ctrl+Z)"
                icon={Undo2Icon}
                onClick={undo}
                disabled={!undoRef.current.length || Boolean(busy)}
              />
              <ToolButton
                label="Redo (⌘/Ctrl+Shift+Z)"
                icon={Redo2Icon}
                onClick={redo}
                disabled={!redoRef.current.length || Boolean(busy)}
              />
            </div>
            <div className="shot-editor-inspector">
              <label className="shot-editor-color" title="Annotation color">
                <input
                  type="color"
                  value={color}
                  onChange={(event) => updateStyle(event.target.value, strokeWidth)}
                  disabled={Boolean(busy)}
                  aria-label="Annotation color"
                  list="shot-editor-colors"
                />
                <span style={{ backgroundColor: color }} />
              </label>
              <datalist id="shot-editor-colors">
                {COLORS.map((value) => (
                  <option key={value} value={value} />
                ))}
              </datalist>
              <div className="shot-editor-color-info">
                <strong>{color.toUpperCase()}</strong>
                <label>
                  Stroke{" "}
                  <select
                    value={strokeWidth}
                    disabled={Boolean(busy)}
                    onChange={(event) => updateStyle(color, Number(event.target.value))}
                    aria-label="Stroke width"
                  >
                    {[2, 4, 6, 10, 16].map((width) => (
                      <option key={width} value={width}>
                        {width} px
                      </option>
                    ))}
                  </select>
                </label>
              </div>
            </div>
            <div className="shot-editor-size">
              <strong>
                {loaded ? `${document.crop.width}×${document.crop.height}` : "—"}
                <span> px</span>
              </strong>
              <span>Image size</span>
            </div>
            <label className="shot-editor-zoom">
              <select
                aria-label="Zoom"
                value={zoom === null ? "fit" : String(zoom)}
                onChange={(event) =>
                  setZoom(event.target.value === "fit" ? null : Number(event.target.value))
                }
              >
                <option value="fit">{Math.round(fitZoom * 100)}% · Fit</option>
                {[
                  0.25,
                  0.5,
                  0.75,
                  1,
                  1.5,
                  2,
                  3,
                  4,
                  ...(zoom !== null && ![0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4].includes(zoom)
                    ? [zoom]
                    : []),
                ]
                  .sort((a, b) => a - b)
                  .map((value) => (
                    <option key={value} value={value}>
                      {Math.round(value * 100)}%
                    </option>
                  ))}
              </select>
              <span>Zoom</span>
            </label>
          </header>
          <div className="shot-editor-workspace" ref={observeWorkspace}>
            <div
              className="shot-editor-stage-wrap"
              style={{
                minWidth: document.crop.width * scale + 48,
                minHeight: document.crop.height * scale + 48,
              }}
            >
              {loaded ? (
                <div
                  ref={stageRef}
                  className="shot-editor-stage"
                  style={{
                    width: document.crop.width * scale,
                    height: document.crop.height * scale,
                    cursor:
                      tool === "pan"
                        ? "grab"
                        : tool === "select"
                          ? "default"
                          : tool === "text"
                            ? "text"
                            : "crosshair",
                  }}
                  role="application"
                  aria-label="Image annotation canvas"
                  tabIndex={0}
                  onPointerDown={pointerDown}
                  onPointerMove={pointerMove}
                  onPointerUp={pointerUp}
                  onPointerCancel={cancelGesture}
                  onDoubleClick={(event) => {
                    if (busy || tool !== "select") return;
                    const bounds = stageRef.current!.getBoundingClientRect();
                    const point = {
                      x: document.crop.x + (event.clientX - bounds.left) / scale,
                      y: document.crop.y + (event.clientY - bounds.top) / scale,
                    };
                    const hit = document.annotations
                      .toReversed()
                      .find(
                        (annotation) =>
                          annotation.tool === "text" &&
                          containsPoint(annotationBounds(annotation), point, 7 / scale),
                      );
                    if (hit) {
                      setEditing(hit);
                      setEditingText(hit.text || "");
                    }
                  }}
                >
                  <svg
                    width="100%"
                    height="100%"
                    viewBox={`${document.crop.x} ${document.crop.y} ${document.crop.width} ${document.crop.height}`}
                    aria-label="Captured image with annotations"
                    role="img"
                  >
                    <image
                      href={image.dataUrl}
                      width={imageRef.current?.naturalWidth}
                      height={imageRef.current?.naturalHeight}
                    />
                    <g pointerEvents="none">
                      {document.annotations
                        .filter((annotation) => annotation.id !== editing?.id)
                        .map((annotation) => (
                          <AnnotationShape key={annotation.id} annotation={annotation} />
                        ))}
                    </g>
                    {selected?.tool === "arrow" && tool === "select" && !editing && (
                      <g pointerEvents="none">
                        {arrowHandles(selected).map((point, index) => (
                          <circle
                            key={["start", "curve", "end"][index]}
                            cx={point.x}
                            cy={point.y}
                            r={5 / scale}
                            fill="white"
                            stroke="#1687ff"
                            strokeWidth={1.5 / scale}
                          />
                        ))}
                      </g>
                    )}
                    {selectionBounds &&
                      selected?.tool !== "arrow" &&
                      tool === "select" &&
                      !editing && (
                        <g pointerEvents="none">
                          <rect
                            {...selectionBounds}
                            fill="none"
                            stroke="#1687ff"
                            strokeWidth={1 / scale}
                            strokeDasharray={`${4 / scale} ${3 / scale}`}
                          />
                          {[0, 1, 2, 3].map((corner) => (
                            <rect
                              key={corner}
                              x={
                                selectionBounds.x +
                                (corner % 2) * selectionBounds.width -
                                3.5 / scale
                              }
                              y={
                                selectionBounds.y +
                                Math.floor(corner / 2) * selectionBounds.height -
                                3.5 / scale
                              }
                              width={7 / scale}
                              height={7 / scale}
                              fill="white"
                              stroke="#1687ff"
                              strokeWidth={1 / scale}
                            />
                          ))}
                        </g>
                      )}
                    {cropSelection && (
                      <g pointerEvents="none">
                        <path
                          d={`M${document.crop.x},${document.crop.y}h${document.crop.width}v${document.crop.height}h-${document.crop.width}Z M${cropSelection.x},${cropSelection.y}h${cropSelection.width}v${cropSelection.height}h-${cropSelection.width}Z`}
                          fill="black"
                          fillRule="evenodd"
                          opacity={0.45}
                        />
                        <rect
                          {...cropSelection}
                          fill="none"
                          stroke="white"
                          strokeWidth={1 / scale}
                          strokeDasharray={`${5 / scale} ${4 / scale}`}
                        />
                      </g>
                    )}
                  </svg>
                  {editing && (
                    <textarea
                      ref={textRef}
                      aria-label="Annotation text"
                      className="shot-editor-text-input"
                      value={editingText}
                      placeholder="Type here…"
                      style={{
                        left: (editing.points[0]!.x - document.crop.x) * scale,
                        top: (editing.points[0]!.y - document.crop.y) * scale,
                        color: "#ffffff",
                        background: editing.color,
                        padding: editing.fontSize * 0.3 * scale,
                        fontSize: editing.fontSize * scale,
                        lineHeight: 1.25,
                        width: Math.max(
                          180,
                          annotationBounds({ ...editing, text: editingText }).width * scale + 24,
                        ),
                        minHeight: editing.fontSize * scale * 1.25 + 12,
                      }}
                      onChange={(event) => setEditingText(event.target.value)}
                      onBlur={finishText}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") {
                          event.preventDefault();
                          event.stopPropagation();
                          setEditing(null);
                        } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                          event.preventDefault();
                          event.stopPropagation();
                          event.currentTarget.blur();
                          stageRef.current?.focus();
                        }
                      }}
                    />
                  )}
                </div>
              ) : (
                <div className="shot-editor-loading" role="status">
                  {error ? "Capture unavailable" : "Opening capture…"}
                </div>
              )}
            </div>
          </div>
          <footer className="shot-editor-footer">
            <span className="shot-editor-hint">{hint}</span>
            {cropSelection && (
              <div className="shot-editor-footer-actions">
                <button
                  type="button"
                  onClick={() => setCropSelection(null)}
                  disabled={Boolean(busy)}
                >
                  Cancel crop
                </button>
                <button type="button" onClick={applyCrop} disabled={Boolean(busy)}>
                  <CheckIcon size={14} />
                  Apply crop
                </button>
              </div>
            )}
            {selected && !cropSelection && (
              <ToolButton
                label="Delete annotation (Delete)"
                icon={Trash2Icon}
                onClick={removeSelected}
                disabled={Boolean(busy)}
                className="shot-editor-small-button"
              />
            )}
            <ToolButton
              label="Fit image to window (0)"
              icon={RotateCcwIcon}
              onClick={() => setZoom(null)}
              className="shot-editor-small-button"
            />
            <span className="shot-editor-status" role="status">
              {busy
                ? busy === "copy"
                  ? "Copying…"
                  : busy === "chat"
                    ? "Saving to chat…"
                    : "Downloading…"
                : "App Shot"}
            </span>
          </footer>
          {error && (
            <div className="shot-editor-error" role="alert">
              <span>{error}</span>
              <button type="button" aria-label="Dismiss error" onClick={() => setError(null)}>
                <XIcon size={16} />
              </button>
            </div>
          )}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export default SnapShotEditor;
