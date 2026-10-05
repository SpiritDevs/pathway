import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import {
  ArrowUpRightIcon,
  CheckIcon,
  CircleIcon,
  EraserIcon,
  MinusIcon,
  MousePointer2Icon,
  Redo2Icon,
  SignatureIcon,
  SquareIcon,
  TypeIcon,
  Undo2Icon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { DIALOG_BACKDROP_CLASS } from "~/components/ui/dialog-styles";
import {
  SKETCH_FONT_FAMILY,
  SKETCH_FONT_WEIGHT,
  SKETCH_TEXT_LINE_HEIGHT,
  drawSketchScene,
  exportSketch,
  moveSketchElement,
  sketchElementBounds,
  sketchElementTouches,
  sketchFontSize,
  sketchSceneBounds,
  type SketchElement,
  type SketchPoint,
  type SketchScene,
} from "~/lib/sketch";
import { cn, randomUUID } from "~/lib/utils";

type ShapeKind = "rectangle" | "ellipse" | "arrow" | "line";
type SketchTool = "select" | "pen" | "text" | "eraser" | ShapeKind;
type Elements = SketchElement[];
type Gesture =
  | { kind: "draw"; element: SketchElement }
  | { kind: "move"; start: SketchPoint; original: SketchElement; current: SketchElement }
  | { kind: "erase"; erased: Set<string>; last: SketchPoint };
type TextEdit = { id: string; at: SketchPoint; color: string; size: number };

export type SketchDialogResult = { scene: SketchScene; image: Blob };
export type SketchDialogProps = {
  /** The scene of an attached sketch being edited; null starts a blank page. */
  initialScene: SketchScene | null;
  onCancel: () => void;
  /** Receives the scene and its PNG. The caller unmounts the dialog once it resolves. */
  onDone: (result: SketchDialogResult) => Promise<void>;
};

const SHAPES: { kind: ShapeKind; label: string; key: string; icon: LucideIcon }[] = [
  { kind: "rectangle", label: "Rectangle", key: "R", icon: SquareIcon },
  { kind: "ellipse", label: "Ellipse", key: "O", icon: CircleIcon },
  { kind: "arrow", label: "Arrow", key: "A", icon: ArrowUpRightIcon },
  { kind: "line", label: "Line", key: "L", icon: MinusIcon },
];
const TOOL_KEYS: Record<string, SketchTool> = {
  v: "select",
  p: "pen",
  t: "text",
  e: "eraser",
  ...Object.fromEntries(SHAPES.map((shape) => [shape.key.toLowerCase(), shape.kind])),
};
const COLORS = [
  { value: "#000000", name: "Black" },
  { value: "#6b7280", name: "Gray" },
  { value: "#8b4513", name: "Brown" },
  { value: "#dc2626", name: "Red" },
  { value: "#ea7a1f", name: "Orange" },
  { value: "#f2a531", name: "Amber" },
  { value: "#3a9a48", name: "Green" },
  { value: "#2f8f83", name: "Teal" },
  { value: "#45a9d4", name: "Sky" },
  { value: "#2f6fe4", name: "Blue" },
  { value: "#4b49dc", name: "Indigo" },
  { value: "#8a3ee0", name: "Purple" },
  { value: "#d6337a", name: "Pink" },
];
const MIN_SIZE = 2;
const MAX_SIZE = 24;
const HISTORY_LIMIT = 100;
const SELECT_PADDING = 6;
const ICON_BUTTON_CLASS =
  "grid size-9 shrink-0 place-items-center rounded-full text-neutral-600 outline-none transition-colors hover:bg-black/5 hover:text-neutral-950 focus-visible:ring-2 focus-visible:ring-sky-500/70 disabled:pointer-events-none disabled:opacity-35 aria-pressed:bg-black/[0.07] aria-pressed:text-neutral-950";

const round = (value: number) => Math.round(value * 10) / 10;

const SHAPE_KINDS = new Set<string>(SHAPES.map((shape) => shape.kind));
function isShape(value: string): value is ShapeKind {
  return SHAPE_KINDS.has(value);
}

function contains(element: SketchElement, point: SketchPoint) {
  const bounds = sketchElementBounds(element);
  return (
    point.x >= bounds.x - SELECT_PADDING &&
    point.x <= bounds.x + bounds.width + SELECT_PADDING &&
    point.y >= bounds.y - SELECT_PADDING &&
    point.y <= bounds.y + bounds.height + SELECT_PADDING
  );
}

/** Squares boxes and snaps lines to 45° while Shift is held. */
function constrainedEnd(kind: ShapeKind, start: SketchPoint, end: SketchPoint): SketchPoint {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (kind === "rectangle" || kind === "ellipse") {
    const side = Math.max(Math.abs(dx), Math.abs(dy));
    return { x: start.x + (Math.sign(dx) || 1) * side, y: start.y + (Math.sign(dy) || 1) * side };
  }
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  const distance = Math.hypot(dx, dy);
  return {
    x: round(start.x + Math.cos(angle) * distance),
    y: round(start.y + Math.sin(angle) * distance),
  };
}

/** A cursor that previews the brush, so size and color read before the first stroke. */
function brushCursor(tool: SketchTool, color: string, size: number): string {
  if (tool === "select") return "default";
  if (tool === "text") return "text";
  if (tool !== "pen" && tool !== "eraser") return "crosshair";
  const diameter = tool === "pen" ? Math.max(4, size) : eraserRadius(size) * 2;
  const box = Math.ceil(diameter + 4);
  const center = box / 2;
  const circle =
    tool === "pen"
      ? `<circle cx="${center}" cy="${center}" r="${diameter / 2}" fill="${color}" stroke="black" stroke-opacity="0.3" stroke-width="1"/>`
      : `<circle cx="${center}" cy="${center}" r="${diameter / 2}" fill="white" fill-opacity="0.6" stroke="#525252" stroke-width="1"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${box}" height="${box}">${circle}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${center} ${center}, crosshair`;
}

function eraserRadius(size: number) {
  return Math.max(6, size);
}

function ToolButton(props: {
  label: string;
  icon: LucideIcon;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      className={ICON_BUTTON_CLASS}
      aria-label={props.label}
      aria-pressed={props.pressed}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      <Icon className="size-[18px]" strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
}

/** Vertical stroke-size control; `onCommit` fires once per drag or key press. */
function SizeSlider(props: {
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
  onCommit: (value: number) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const valueRef = useRef(props.value);
  valueRef.current = props.value;
  const ratio = (props.value - MIN_SIZE) / (MAX_SIZE - MIN_SIZE);
  const setFromPointer = (clientY: number) => {
    const track = trackRef.current?.getBoundingClientRect();
    if (!track || track.height === 0) return;
    const fraction = Math.min(1, Math.max(0, 1 - (clientY - track.top) / track.height));
    const next = Math.round(MIN_SIZE + fraction * (MAX_SIZE - MIN_SIZE));
    valueRef.current = next;
    props.onChange(next);
  };
  const step = (next: number) => {
    const clamped = Math.min(MAX_SIZE, Math.max(MIN_SIZE, next));
    props.onChange(clamped);
    props.onCommit(clamped);
  };
  return (
    <div
      role="slider"
      tabIndex={props.disabled ? -1 : 0}
      aria-label="Stroke size"
      aria-orientation="vertical"
      aria-valuemin={MIN_SIZE}
      aria-valuemax={MAX_SIZE}
      aria-valuenow={props.value}
      aria-disabled={props.disabled || undefined}
      title="Stroke size"
      className="absolute top-1/2 left-2 flex h-52 w-9 -translate-y-1/2 cursor-pointer touch-none flex-col items-center rounded-full py-3 outline-none focus-visible:ring-2 focus-visible:ring-sky-500/70 aria-disabled:pointer-events-none"
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setFromPointer(event.clientY);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) setFromPointer(event.clientY);
      }}
      onPointerUp={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        event.currentTarget.releasePointerCapture(event.pointerId);
        props.onCommit(valueRef.current);
      }}
      onKeyDown={(event) => {
        const delta =
          event.key === "ArrowUp" || event.key === "ArrowRight"
            ? 1
            : event.key === "ArrowDown" || event.key === "ArrowLeft"
              ? -1
              : 0;
        if (delta !== 0) step(props.value + delta);
        else if (event.key === "Home") step(MIN_SIZE);
        else if (event.key === "End") step(MAX_SIZE);
        else return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div ref={trackRef} className="relative w-0.5 flex-1 rounded-full bg-neutral-300">
        <div
          className="absolute left-1/2 size-4 -translate-x-1/2 translate-y-1/2 rounded-full border border-neutral-300 bg-white shadow-[0_1px_3px_rgb(0_0_0/0.18)]"
          style={{ bottom: `${ratio * 100}%` }}
        />
      </div>
    </div>
  );
}

function Swatch(props: {
  label: string;
  selected: boolean;
  disabled: boolean;
  style: React.CSSProperties;
  onClick?: () => void;
  children?: ReactNode;
}) {
  const className = cn(
    "relative grid size-7 shrink-0 cursor-pointer place-items-center rounded-full outline-offset-2 transition-transform hover:scale-110 has-focus-visible:outline-2 has-focus-visible:outline-sky-500 focus-visible:outline-2 focus-visible:outline-sky-500",
    props.selected && "outline-2 outline-neutral-900",
    props.disabled && "pointer-events-none opacity-40",
  );
  if (!props.onClick) {
    return (
      <label className={className} style={props.style} title={props.label}>
        {props.children}
      </label>
    );
  }
  return (
    <button
      type="button"
      className={className}
      style={props.style}
      aria-label={props.label}
      aria-pressed={props.selected}
      title={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

/**
 * A whiteboard for drawing a quick design. The page is always white, so what the user
 * sees is what the exported PNG shows. The vector scene goes back to the caller so the
 * attachment can be reopened and edited until the message is sent.
 */
export function SketchDialog({ initialScene, onCancel, onDone }: SketchDialogProps) {
  const [elements, setElements] = useState<Elements>(() => initialScene?.elements ?? []);
  const elementsRef = useRef(elements);
  const undoRef = useRef<Elements[]>([]);
  const redoRef = useRef<Elements[]>([]);
  const [tool, setTool] = useState<SketchTool>("pen");
  const [shape, setShape] = useState<ShapeKind>("rectangle");
  const [shapesOpen, setShapesOpen] = useState(false);
  const [color, setColor] = useState(COLORS[0]!.value);
  const [size, setSize] = useState(4);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [textEdit, setTextEdit] = useState<TextEdit | null>(null);
  const textEditRef = useRef<TextEdit | null>(null);
  const [text, setText] = useState("");
  const [offset, setOffset] = useState<SketchPoint>({ x: 0, y: 0 });
  const offsetRef = useRef(offset);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const selectionRef = useRef<HTMLDivElement>(null);
  const gestureRef = useRef<Gesture | null>(null);
  const frameRef = useRef(0);
  const viewRef = useRef({ width: 0, height: 0, ratio: 1, placed: false });

  const selected = elements.find((element) => element.id === selectedId) ?? null;
  const selectedBounds = selected && !textEdit ? sketchElementBounds(selected) : null;
  const dirty = undoRef.current.length > 0 || (textEdit !== null && text.trim().length > 0);
  const empty = elements.length === 0 && !(textEdit && text.trim());

  /** The elements as they look mid-gesture, minus any text open in the editor. */
  const visibleElements = useCallback((): Elements => {
    const gesture = gestureRef.current;
    let visible = elementsRef.current;
    if (gesture?.kind === "draw") visible = [...visible, gesture.element];
    else if (gesture?.kind === "move")
      visible = visible.map((element) =>
        element.id === gesture.current.id ? gesture.current : element,
      );
    else if (gesture?.kind === "erase")
      visible = visible.filter((element) => !gesture.erased.has(element.id));
    const editingId = textEditRef.current?.id;
    return editingId ? visible.filter((element) => element.id !== editingId) : visible;
  }, []);

  const draw = useCallback(() => {
    frameRef.current = 0;
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    const { width, height, ratio } = viewRef.current;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, width * ratio, height * ratio);
    context.setTransform(
      ratio,
      0,
      0,
      ratio,
      offsetRef.current.x * ratio,
      offsetRef.current.y * ratio,
    );
    drawSketchScene(context, visibleElements());
  }, [visibleElements]);

  const scheduleDraw = useCallback(() => {
    if (!frameRef.current) frameRef.current = requestAnimationFrame(draw);
  }, [draw]);

  useLayoutEffect(() => {
    draw();
  }, [draw, elements, offset, textEdit]);

  useLayoutEffect(() => () => cancelAnimationFrame(frameRef.current), []);

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textEdit || !textarea) return;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, [textEdit]);

  const observeHost = useCallback(
    (host: HTMLDivElement | null) => {
      hostRef.current = host;
      if (!host) return;
      const resize = (width: number, height: number) => {
        const canvas = canvasRef.current;
        if (!canvas || width === 0 || height === 0) return;
        const ratio = window.devicePixelRatio || 1;
        viewRef.current = { ...viewRef.current, width, height, ratio };
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        if (!viewRef.current.placed) {
          viewRef.current.placed = true;
          // A sketch reopened in a smaller window is centered rather than left off the page.
          const bounds = sketchSceneBounds(elementsRef.current);
          if (
            bounds &&
            (bounds.x < 0 ||
              bounds.y < 0 ||
              bounds.x + bounds.width > width ||
              bounds.y + bounds.height > height)
          ) {
            const next = {
              x: Math.round(width / 2 - (bounds.x + bounds.width / 2)),
              y: Math.round(height / 2 - (bounds.y + bounds.height / 2)),
            };
            offsetRef.current = next;
            setOffset(next);
          }
        }
        draw();
      };
      resize(host.clientWidth, host.clientHeight);
      const observer = new ResizeObserver(([entry]) => {
        if (entry) resize(entry.contentRect.width, entry.contentRect.height);
      });
      observer.observe(host);
      return () => observer.disconnect();
    },
    [draw],
  );

  function apply(next: Elements) {
    elementsRef.current = next;
    setElements(next);
  }

  function commit(next: Elements) {
    undoRef.current = [...undoRef.current.slice(-(HISTORY_LIMIT - 1)), elementsRef.current];
    redoRef.current = [];
    apply(next);
  }

  function travel(from: React.RefObject<Elements[]>, to: React.RefObject<Elements[]>) {
    finishText();
    const target = from.current.pop();
    if (!target) return;
    to.current.push(elementsRef.current);
    setSelectedId(null);
    apply(target);
  }
  const undo = () => travel(undoRef, redoRef);
  const redo = () => travel(redoRef, undoRef);

  function openText(edit: TextEdit, initialText: string) {
    textEditRef.current = edit;
    setTextEdit(edit);
    setText(initialText);
    setSelectedId(null);
  }

  /** Commits the open text box, if any, and returns the resulting elements. */
  function finishText(): Elements {
    const edit = textEditRef.current;
    if (!edit) return elementsRef.current;
    textEditRef.current = null;
    setTextEdit(null);
    const current = elementsRef.current;
    const previous = current.find((element) => element.id === edit.id);
    const value = text.replace(/\s+$/, "");
    if (previous?.text === value) return current;
    if (!value.trim()) {
      if (previous) commit(current.filter((element) => element.id !== edit.id));
      return elementsRef.current;
    }
    const element: SketchElement = {
      id: edit.id,
      kind: "text",
      points: [edit.at],
      color: edit.color,
      size: edit.size,
      text: value,
    };
    commit(
      previous
        ? current.map((item) => (item.id === edit.id ? element : item))
        : [...current, element],
    );
    return elementsRef.current;
  }

  function chooseTool(next: SketchTool) {
    finishText();
    setTool(next);
    if (isShape(next)) setShape(next);
    if (next !== "select") setSelectedId(null);
    hostRef.current?.focus({ preventScroll: true });
  }

  /** Restyles the selected element too, so picking a swatch recolors what's selected. */
  function restyle(nextColor: string, nextSize: number) {
    setColor(nextColor);
    setSize(nextSize);
    if (!selected || (selected.color === nextColor && selected.size === nextSize)) return;
    commit(
      elementsRef.current.map((element) =>
        element.id === selected.id ? { ...element, color: nextColor, size: nextSize } : element,
      ),
    );
  }

  function removeSelected() {
    if (!selectedId) return;
    commit(elementsRef.current.filter((element) => element.id !== selectedId));
    setSelectedId(null);
  }

  function toScene(clientX: number, clientY: number): SketchPoint {
    const bounds = hostRef.current!.getBoundingClientRect();
    return {
      x: round(clientX - bounds.left - offsetRef.current.x),
      y: round(clientY - bounds.top - offsetRef.current.y),
    };
  }

  function topmostAt(point: SketchPoint, predicate: (element: SketchElement) => boolean) {
    return elementsRef.current.findLast(
      (element) => predicate(element) && contains(element, point),
    );
  }

  function eraseAlong(gesture: Extract<Gesture, { kind: "erase" }>, point: SketchPoint) {
    const radius = eraserRadius(size);
    // Sample the path between pointer events so a fast swipe cannot skip a thin line.
    const distance = Math.hypot(point.x - gesture.last.x, point.y - gesture.last.y);
    const steps = Math.max(1, Math.ceil(distance / (radius / 2)));
    let changed = false;
    for (let index = 1; index <= steps; index += 1) {
      const sample = {
        x: gesture.last.x + ((point.x - gesture.last.x) * index) / steps,
        y: gesture.last.y + ((point.y - gesture.last.y) * index) / steps,
      };
      for (const element of elementsRef.current) {
        if (gesture.erased.has(element.id)) continue;
        if (sketchElementTouches(element, sample, radius)) {
          gesture.erased.add(element.id);
          changed = true;
        }
      }
    }
    gesture.last = point;
    if (changed) scheduleDraw();
  }

  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (busy || event.button !== 0 || event.target === textareaRef.current) return;
    event.preventDefault();
    setShapesOpen(false);
    setConfirmingDiscard(false);
    if (textEditRef.current) {
      // The first click away from a text box only finishes it.
      finishText();
      hostRef.current?.focus({ preventScroll: true });
      return;
    }
    hostRef.current?.focus({ preventScroll: true });
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = toScene(event.clientX, event.clientY);
    if (tool === "select") {
      const hit = topmostAt(point, () => true);
      setSelectedId(hit?.id ?? null);
      if (hit) {
        setColor(hit.color);
        setSize(hit.size);
        gestureRef.current = { kind: "move", start: point, original: hit, current: hit };
      }
      return;
    }
    setSelectedId(null);
    if (tool === "text") {
      const hit = topmostAt(point, (element) => element.kind === "text");
      if (hit)
        openText(
          { id: hit.id, at: hit.points[0]!, color: hit.color, size: hit.size },
          hit.text ?? "",
        );
      else openText({ id: randomUUID(), at: point, color, size }, "");
      return;
    }
    if (tool === "eraser") {
      const gesture = { kind: "erase" as const, erased: new Set<string>(), last: point };
      gestureRef.current = gesture;
      eraseAlong(gesture, point);
      return;
    }
    gestureRef.current = {
      kind: "draw",
      element: {
        id: randomUUID(),
        kind: tool,
        points: tool === "pen" ? [point] : [point, point],
        color,
        size,
      },
    };
    scheduleDraw();
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    if (!gesture) return;
    const point = toScene(event.clientX, event.clientY);
    if (gesture.kind === "erase") {
      eraseAlong(gesture, point);
      return;
    }
    if (gesture.kind === "move") {
      const delta = { x: point.x - gesture.start.x, y: point.y - gesture.start.y };
      gesture.current = moveSketchElement(gesture.original, delta);
      // The outline follows by transform; React state settles when the drag ends.
      if (selectionRef.current) selectionRef.current.style.translate = `${delta.x}px ${delta.y}px`;
      scheduleDraw();
      return;
    }
    const element = gesture.element;
    if (element.kind === "pen") {
      const samples = event.nativeEvent.getCoalescedEvents?.() ?? [];
      const points = [...element.points];
      for (const sample of samples.length > 0 ? samples : [event.nativeEvent]) {
        const next = toScene(sample.clientX, sample.clientY);
        const last = points.at(-1)!;
        if (Math.hypot(next.x - last.x, next.y - last.y) >= 1) points.push(next);
      }
      if (points.length === element.points.length) return;
      gesture.element = { ...element, points };
    } else {
      const start = element.points[0]!;
      const end =
        event.shiftKey && isShape(element.kind)
          ? constrainedEnd(element.kind, start, point)
          : point;
      gesture.element = { ...element, points: [start, end] };
    }
    scheduleDraw();
  }

  function pointerUp(event: PointerEvent<HTMLDivElement>) {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    if (selectionRef.current) selectionRef.current.style.translate = "";
    if (!gesture) return;
    if (gesture.kind === "erase") {
      if (gesture.erased.size > 0)
        commit(elementsRef.current.filter((element) => !gesture.erased.has(element.id)));
    } else if (gesture.kind === "move") {
      if (gesture.current !== gesture.original)
        commit(
          elementsRef.current.map((element) =>
            element.id === gesture.original.id ? gesture.current : element,
          ),
        );
    } else {
      const [start, end] = gesture.element.points;
      // A click with a shape tool draws nothing; a click with the pen leaves a dot.
      const degenerate =
        gesture.element.kind !== "pen" &&
        start !== undefined &&
        end !== undefined &&
        Math.abs(end.x - start.x) + Math.abs(end.y - start.y) < 3;
      if (!degenerate) commit([...elementsRef.current, gesture.element]);
    }
    scheduleDraw();
  }

  function cancelGesture() {
    gestureRef.current = null;
    if (selectionRef.current) selectionRef.current.style.translate = "";
    scheduleDraw();
  }

  /** Escape and the close button unwind one layer at a time before leaving. */
  function requestClose() {
    if (busy) return;
    if (confirmingDiscard) {
      setConfirmingDiscard(false);
      return;
    }
    if (textEditRef.current) {
      finishText();
      hostRef.current?.focus({ preventScroll: true });
      return;
    }
    if (shapesOpen) {
      setShapesOpen(false);
      return;
    }
    if (selectedId) {
      setSelectedId(null);
      return;
    }
    if (dirty) setConfirmingDiscard(true);
    else onCancel();
  }

  async function done() {
    if (busy) return;
    const scene = { elements: finishText() };
    if (scene.elements.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const { blob } = await exportSketch(scene);
      await onDone({ scene, image: blob });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The sketch could not be attached.");
      setBusy(false);
    }
  }

  function keyDown(event: KeyboardEvent<HTMLDivElement>) {
    // Keep the composer and app shortcuts from reacting underneath the dialog.
    event.stopPropagation();
    const key = event.key.toLowerCase();
    const command = event.metaKey || event.ctrlKey;
    if (key === "escape") {
      event.preventDefault();
      requestClose();
      return;
    }
    if (command && key === "enter") {
      event.preventDefault();
      void done();
      return;
    }
    if (busy || event.target === textareaRef.current) return;
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
    if ((key === "delete" || key === "backspace") && selectedId) {
      event.preventDefault();
      removeSelected();
      return;
    }
    if (command || event.altKey) return;
    const next = TOOL_KEYS[key];
    if (next) {
      event.preventDefault();
      chooseTool(next);
    }
  }

  const textFontSize = textEdit ? sketchFontSize(textEdit.size) : 0;
  const textWidth = textEdit
    ? sketchElementBounds({
        id: textEdit.id,
        kind: "text",
        points: [textEdit.at],
        color: textEdit.color,
        size: textEdit.size,
        text: text || " ",
      }).width
    : 0;
  const ShapeIcon = SHAPES.find((item) => item.kind === shape)!.icon;
  const customColor = !COLORS.some((item) => item.value === color);

  return (
    <DialogPrimitive.Root
      open
      disablePointerDismissal
      onOpenChange={(open, details) => {
        // Escape is unwound layer by layer in keyDown; any other close request lands here.
        if (!open && details.reason !== "escape-key") requestClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className={DIALOG_BACKDROP_CLASS} />
        <DialogPrimitive.Popup
          initialFocus={hostRef}
          onKeyDown={keyDown}
          className="fixed inset-3 z-[130] m-auto max-h-[880px] max-w-[1120px] overflow-hidden rounded-[22px] bg-white text-neutral-900 shadow-[0_24px_80px_-24px_rgb(0_0_0/0.45)] ring-1 ring-black/10 outline-none transition-[scale,opacity] duration-200 ease-out [-webkit-app-region:no-drag] [color-scheme:light] data-ending-style:scale-98 data-ending-style:opacity-0 data-starting-style:scale-98 data-starting-style:opacity-0 sm:inset-6"
        >
          <DialogPrimitive.Title className="sr-only">Sketch</DialogPrimitive.Title>
          <DialogPrimitive.Description className="sr-only">
            Draw with the pen, shapes, and text tools, then add the sketch to your message. Press
            Command or Control Enter to finish.
          </DialogPrimitive.Description>

          <div
            ref={observeHost}
            tabIndex={-1}
            role="application"
            aria-label="Sketch canvas"
            className="absolute inset-0 touch-none outline-none select-none"
            style={{ cursor: busy ? "progress" : brushCursor(tool, color, size) }}
            onPointerDown={pointerDown}
            onPointerMove={pointerMove}
            onPointerUp={pointerUp}
            onPointerCancel={cancelGesture}
            onMouseDown={(event) => {
              // Focus is managed explicitly; a default mousedown would pull it off a new text box.
              if (event.target !== textareaRef.current) event.preventDefault();
            }}
            onDoubleClick={(event) => {
              if (busy || tool !== "select") return;
              const hit = topmostAt(
                toScene(event.clientX, event.clientY),
                (element) => element.kind === "text",
              );
              if (hit)
                openText(
                  { id: hit.id, at: hit.points[0]!, color: hit.color, size: hit.size },
                  hit.text ?? "",
                );
            }}
          >
            <canvas ref={canvasRef} className="pointer-events-none absolute inset-0 size-full" />
            {selectedBounds && tool === "select" ? (
              <div
                ref={selectionRef}
                aria-hidden="true"
                className="pointer-events-none absolute rounded-[3px] border border-dashed border-sky-500"
                style={{
                  left: selectedBounds.x + offset.x - SELECT_PADDING / 2,
                  top: selectedBounds.y + offset.y - SELECT_PADDING / 2,
                  width: selectedBounds.width + SELECT_PADDING,
                  height: selectedBounds.height + SELECT_PADDING,
                }}
              />
            ) : null}
            {textEdit ? (
              <textarea
                ref={textareaRef}
                aria-label="Sketch text"
                value={text}
                rows={Math.max(1, text.split("\n").length)}
                spellCheck={false}
                placeholder="Type…"
                className="absolute resize-none overflow-hidden border-0 bg-transparent p-0 whitespace-pre outline-none placeholder:text-neutral-400"
                style={{
                  left: textEdit.at.x + offset.x,
                  // Canvas text hangs from the em box; CSS adds half-leading above it.
                  top:
                    textEdit.at.y + offset.y - ((SKETCH_TEXT_LINE_HEIGHT - 1) / 2) * textFontSize,
                  width: textWidth + textFontSize,
                  color: textEdit.color,
                  caretColor: textEdit.color,
                  font: `${SKETCH_FONT_WEIGHT} ${textFontSize}px/${SKETCH_TEXT_LINE_HEIGHT} ${SKETCH_FONT_FAMILY}`,
                }}
                onChange={(event) => setText(event.target.value)}
                onBlur={() => finishText()}
              />
            ) : null}
          </div>

          <button
            type="button"
            className={cn(ICON_BUTTON_CLASS, "absolute top-3 left-3")}
            aria-label="Close sketch"
            title="Close"
            disabled={busy}
            onClick={requestClose}
          >
            <XIcon className="size-[18px]" strokeWidth={1.75} aria-hidden="true" />
          </button>

          <div className="absolute top-3 left-1/2 -translate-x-1/2">
            <div
              role="toolbar"
              aria-label="Sketch tools"
              className="flex items-center gap-0.5 rounded-full border border-black/10 bg-white p-1 shadow-[0_2px_10px_-4px_rgb(0_0_0/0.2)]"
            >
              <ToolButton
                label="Select and move (V)"
                icon={MousePointer2Icon}
                pressed={tool === "select"}
                disabled={busy}
                onClick={() => chooseTool("select")}
              />
              <ToolButton
                label="Pen (P)"
                icon={SignatureIcon}
                pressed={tool === "pen"}
                disabled={busy}
                onClick={() => chooseTool("pen")}
              />
              <ToolButton
                label="Text (T)"
                icon={TypeIcon}
                pressed={tool === "text"}
                disabled={busy}
                onClick={() => chooseTool("text")}
              />
              <button
                type="button"
                className={ICON_BUTTON_CLASS}
                aria-label="Shapes"
                aria-pressed={isShape(tool)}
                aria-expanded={shapesOpen}
                title="Shapes"
                disabled={busy}
                onClick={() => {
                  if (!isShape(tool)) chooseTool(shape);
                  setShapesOpen((open) => !open);
                }}
              >
                <ShapeIcon className="size-[18px]" strokeWidth={1.75} aria-hidden="true" />
              </button>
              <ToolButton
                label="Eraser (E)"
                icon={EraserIcon}
                pressed={tool === "eraser"}
                disabled={busy}
                onClick={() => chooseTool("eraser")}
              />
            </div>
            {shapesOpen ? (
              <div
                role="group"
                aria-label="Shape"
                className="absolute top-[calc(100%+6px)] left-1/2 flex -translate-x-1/2 gap-0.5 rounded-full border border-black/10 bg-white p-1 shadow-[0_8px_24px_-12px_rgb(0_0_0/0.35)]"
              >
                {SHAPES.map((item) => (
                  <ToolButton
                    key={item.kind}
                    label={`${item.label} (${item.key})`}
                    icon={item.icon}
                    pressed={tool === item.kind}
                    onClick={() => {
                      chooseTool(item.kind);
                      setShapesOpen(false);
                    }}
                  />
                ))}
              </div>
            ) : null}
          </div>

          <div className="absolute top-3 right-3 flex gap-0.5">
            <ToolButton
              label="Undo (⌘Z)"
              icon={Undo2Icon}
              disabled={busy || undoRef.current.length === 0}
              onClick={undo}
            />
            <ToolButton
              label="Redo (⇧⌘Z)"
              icon={Redo2Icon}
              disabled={busy || redoRef.current.length === 0}
              onClick={redo}
            />
          </div>

          <SizeSlider
            value={size}
            disabled={busy}
            onChange={setSize}
            onCommit={(value) => restyle(color, value)}
          />

          <div
            role="group"
            aria-label="Color"
            className="absolute bottom-3 left-1/2 flex max-w-[calc(100%-7.5rem)] -translate-x-1/2 items-center gap-1.5 overflow-x-auto rounded-full bg-white/90 p-1.5 [scrollbar-width:none]"
          >
            <Swatch
              label="Custom color"
              selected={customColor}
              disabled={busy}
              style={{
                background:
                  "conic-gradient(#f43f5e, #f59e0b, #eab308, #22c55e, #06b6d4, #3b82f6, #a855f7, #f43f5e)",
              }}
            >
              <input
                type="color"
                aria-label="Custom color"
                value={color}
                disabled={busy}
                className="absolute inset-0 size-full cursor-pointer opacity-0"
                onChange={(event) => restyle(event.target.value, size)}
              />
              {customColor ? (
                <span
                  className="size-3 rounded-full ring-2 ring-white"
                  style={{ backgroundColor: color }}
                />
              ) : null}
            </Swatch>
            {COLORS.map((item) => (
              <Swatch
                key={item.value}
                label={item.name}
                selected={color === item.value}
                disabled={busy}
                style={{ backgroundColor: item.value }}
                onClick={() => restyle(item.value, size)}
              />
            ))}
          </div>

          <button
            type="button"
            className="absolute right-3 bottom-3 grid size-10 place-items-center rounded-full bg-neutral-900 text-white shadow-sm outline-none transition-colors hover:bg-neutral-700 focus-visible:ring-2 focus-visible:ring-sky-500/70 focus-visible:ring-offset-2 disabled:bg-neutral-300"
            aria-label={initialScene ? "Update sketch (⌘↵)" : "Add sketch to message (⌘↵)"}
            title={initialScene ? "Update sketch (⌘↵)" : "Add to message (⌘↵)"}
            disabled={busy || empty}
            onClick={() => void done()}
          >
            <CheckIcon className="size-5" strokeWidth={2} aria-hidden="true" />
          </button>

          {confirmingDiscard || error ? (
            <div
              role={error ? "alert" : "alertdialog"}
              aria-label={error ? undefined : "Discard sketch"}
              className="absolute bottom-16 left-1/2 flex -translate-x-1/2 items-center gap-3 rounded-full border border-black/10 bg-white py-1.5 pr-1.5 pl-4 text-sm whitespace-nowrap shadow-[0_8px_24px_-12px_rgb(0_0_0/0.35)]"
            >
              {error ? (
                <>
                  <span className="text-red-600">{error}</span>
                  <button
                    type="button"
                    className="rounded-full px-3 py-1 text-neutral-600 hover:bg-black/5"
                    onClick={() => setError(null)}
                  >
                    Dismiss
                  </button>
                </>
              ) : (
                <>
                  <span>{initialScene ? "Discard your changes?" : "Discard this sketch?"}</span>
                  <button
                    type="button"
                    autoFocus
                    className="rounded-full px-3 py-1 text-neutral-600 hover:bg-black/5"
                    onClick={() => {
                      setConfirmingDiscard(false);
                      hostRef.current?.focus({ preventScroll: true });
                    }}
                  >
                    Keep editing
                  </button>
                  <button
                    type="button"
                    className="rounded-full bg-red-600 px-3 py-1 font-medium text-white hover:bg-red-500"
                    onClick={onCancel}
                  >
                    Discard
                  </button>
                </>
              )}
            </div>
          ) : null}
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

export default SketchDialog;
