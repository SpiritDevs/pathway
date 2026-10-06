import { beforeEach, afterEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useState: reactHookHarness.useState,
    useRef: reactHookHarness.useRef,
    useLayoutEffect: () => undefined,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
const png = new Blob(["png"], { type: "image/png" });
vi.mock("../../lib/sketch", async (original) => ({
  ...(await original<typeof import("../../lib/sketch")>()),
  exportSketch: vi.fn(async () => ({ blob: png, width: 120, height: 80 })),
}));

import type { KeyboardEvent, PointerEvent } from "react";
import type { SketchScene } from "../../lib/sketch";
import { SketchDialog, type SketchDialogProps } from "./SketchDialog";

const onCancel = vi.fn();
const onDone = vi.fn<SketchDialogProps["onDone"]>();
const host = {
  clientWidth: 800,
  clientHeight: 600,
  getBoundingClientRect: () => ({ left: 0, top: 0 }),
  focus: vi.fn(),
};

function render(initialScene: SketchScene | null = null) {
  hooks.beginRender();
  return SketchDialog({ initialScene, onCancel, onDone });
}

function find(
  tree: ReturnType<typeof render>,
  predicate: (props: Record<string, unknown>) => boolean,
) {
  const element = visitElements(tree, (node) => predicate(node.props));
  if (!element) throw new Error("Missing element");
  return element.props;
}

function button(tree: ReturnType<typeof render>, label: string) {
  return find(
    tree,
    (props) => props.label === label || props["aria-label"] === label || props.children === label,
  ) as {
    onClick: () => void;
    disabled?: boolean;
  };
}

function keyDown(tree: ReturnType<typeof render>, key: string, metaKey = false) {
  const popup = find(tree, (props) => "initialFocus" in props) as {
    onKeyDown: (event: KeyboardEvent) => void;
  };
  const event = {
    key,
    metaKey,
    ctrlKey: false,
    target: null,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
  popup.onKeyDown(event as unknown as KeyboardEvent);
  return event;
}

function pointer(clientX: number, clientY: number) {
  return {
    button: 0,
    pointerId: 1,
    clientX,
    clientY,
    target: host,
    shiftKey: false,
    preventDefault: vi.fn(),
    nativeEvent: { clientX, clientY, getCoalescedEvents: () => [] },
    currentTarget: {
      setPointerCapture: vi.fn(),
      hasPointerCapture: () => true,
      releasePointerCapture: vi.fn(),
    },
  } as unknown as PointerEvent<HTMLDivElement>;
}

/** Drags a pen stroke across the canvas, re-rendering between events like React would. */
function drawStroke(initialScene: SketchScene | null = null) {
  const canvas = () =>
    find(render(initialScene), (props) => props["aria-label"] === "Sketch canvas") as {
      ref: (node: unknown) => void;
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
    };
  canvas().ref(host);
  canvas().onPointerDown(pointer(10, 10));
  canvas().onPointerMove(pointer(60, 40));
  canvas().onPointerUp(pointer(60, 40));
}

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  onDone.mockResolvedValue(undefined);
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});

afterEach(() => vi.unstubAllGlobals());

it("closes a blank page on Escape without asking", () => {
  const tree = render();
  expect(button(tree, "Add sketch to message (⌘↵)").disabled).toBe(true);
  const event = keyDown(tree, "Escape");
  expect(event.stopPropagation).toHaveBeenCalledOnce();
  expect(onCancel).toHaveBeenCalledOnce();
});

it("hands the drawn scene and its PNG to the composer on Command-Enter", async () => {
  drawStroke();
  keyDown(render(), "Enter", true);
  await vi.waitFor(() => expect(onDone).toHaveBeenCalledOnce());
  expect(onDone).toHaveBeenCalledWith({
    scene: {
      elements: [
        {
          id: expect.any(String),
          kind: "pen",
          points: [
            { x: 10, y: 10 },
            { x: 60, y: 40 },
          ],
          color: "#000000",
          size: 4,
        },
      ],
    },
    image: png,
  });
});

it("asks before discarding a drawing, and keeps it when the user keeps editing", () => {
  drawStroke();
  keyDown(render(), "Escape");
  expect(onCancel).not.toHaveBeenCalled();
  button(render(), "Keep editing").onClick();
  expect(() => button(render(), "Discard")).toThrow("Missing element");
  keyDown(render(), "Escape");
  button(render(), "Discard").onClick();
  expect(onCancel).toHaveBeenCalledOnce();
});

it("reopens an attached sketch with its scene and closes it untouched without asking", () => {
  const scene: SketchScene = {
    elements: [
      {
        id: "stroke-1",
        kind: "rectangle",
        points: [
          { x: 5, y: 5 },
          { x: 90, y: 50 },
        ],
        color: "#dc2626",
        size: 6,
      },
    ],
  };
  const tree = render(scene);
  expect(button(tree, "Update sketch (⌘↵)").disabled).toBe(false);
  expect(button(tree, "Undo (⌘Z)").disabled).toBe(true);
  keyDown(tree, "Escape");
  expect(onCancel).toHaveBeenCalledOnce();
});
