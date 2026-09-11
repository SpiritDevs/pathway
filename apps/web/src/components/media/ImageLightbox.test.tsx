import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "~/test/reactHookHarness";
import { visitElements } from "~/test/reactElementTree";
import { ImageLightbox, type ImageLightboxProps } from "./ImageLightbox";
import { downloadImageFile } from "./imageTransfer";

vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return {
    ...actual,
    memo: (component: unknown) => component,
    useState: reactHookHarness.useState,
    useRef: reactHookHarness.useRef,
    useCallback: reactHookHarness.useCallback,
    useEffect: () => {},
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("./imageTransfer", () => ({
  downloadImageFile: vi.fn().mockResolvedValue(undefined),
  copyImageToClipboard: vi.fn().mockResolvedValue(undefined),
}));

const images = [
  { name: "light.png", src: "https://remote.example/assets/light?token=one" },
  { name: "dark.png", src: "https://remote.example/assets/dark?token=two" },
  { name: "confirmation.png", src: "https://remote.example/assets/confirm?token=three" },
];
let props: ImageLightboxProps;
function render() {
  hooks.beginRender();
  return ImageLightbox(props);
}
function find(predicate: (element: ReactElement<Record<string, unknown>>) => boolean) {
  const element = visitElements(render(), predicate);
  expect(element).not.toBeNull();
  return element!;
}
function action(label: string) {
  const element = find((e) => e.props["aria-label"] === label || e.props.label === label);
  (element.props.onClick as () => void)();
}
function image() {
  return find((e) => e.type === "img" && e.props.alt !== "");
}

beforeEach(() => {
  hooks.reset();
  vi.clearAllMocks();
  props = { images, initialIndex: 1, onClose: vi.fn() };
});

describe("image gallery controls", () => {
  it("starts on the clicked image and wraps in both directions", () => {
    expect(image().props.src).toBe(images[1]!.src);
    action("Next image");
    expect(image().props.src).toBe(images[2]!.src);
    action("Next image");
    expect(image().props.src).toBe(images[0]!.src);
    action("Previous image");
    expect(image().props.src).toBe(images[2]!.src);
  });

  it("zooms, resets when navigating, and selects thumbnails", () => {
    action("Zoom in");
    expect(image().props.style).toEqual({ transform: "translate3d(0px, 0px, 0) scale(1.5)" });
    action("Show light.png");
    expect(image().props.src).toBe(images[0]!.src);
    expect(image().props.style).toEqual({ transform: "translate3d(0px, 0px, 0) scale(1)" });
    action("Zoom in");
    action("Fit image to window");
    expect(image().props.style).toEqual({ transform: "translate3d(0px, 0px, 0) scale(1)" });
  });

  it("advances once per horizontal scroll gesture and ignores vertical scrolling", () => {
    const wheel = (deltaX: number, deltaY: number, timeStamp: number) => {
      const viewport = find((e) => typeof e.props.onWheel === "function");
      (viewport.props.onWheel as (event: unknown) => void)({
        target: { tagName: "DIV" },
        deltaX,
        deltaY,
        timeStamp,
        deltaMode: 0,
      });
    };
    wheel(0, 120, 1000);
    expect(image().props.src).toBe(images[1]!.src);
    wheel(80, 0, 1100);
    wheel(80, 0, 1120);
    expect(image().props.src).toBe(images[2]!.src);
    wheel(-80, 0, 1500);
    expect(image().props.src).toBe(images[1]!.src);
  });

  it("swipes through fitted images and pans instead when zoomed", () => {
    const currentTarget = { setPointerCapture: vi.fn(), hasPointerCapture: () => false };
    const swipe = () => {
      const event = {
        pointerId: 1,
        pointerType: "touch",
        button: 0,
        clientX: 200,
        clientY: 50,
        currentTarget,
        preventDefault: vi.fn(),
      };
      (image().props.onPointerDown as (event: unknown) => void)(event);
      (image().props.onPointerUp as (event: unknown) => void)({
        ...event,
        type: "pointerup",
        clientX: 100,
      });
    };
    swipe();
    expect(image().props.src).toBe(images[2]!.src);
    action("Zoom in");
    swipe();
    expect(image().props.src).toBe(images[2]!.src);
  });

  it("downloads the selected original URL with its filename", () => {
    const download = find(
      (e) => Array.isArray(e.props.children) && e.props.children.includes("Download"),
    );
    (download.props.onClick as () => void)();
    expect(downloadImageFile).toHaveBeenCalledWith(images[1]!.src, "dark.png");
  });

  it("keeps failed and loading images navigable without offering empty downloads", () => {
    props = {
      ...props,
      images: [{ name: "waiting.png", src: "", loading: true }, images[1]!],
      initialIndex: 0,
    };
    expect(find((e) => e.props.role === "status").props.children).toBe("Loading image…");
    expect(
      find((e) => Array.isArray(e.props.children) && e.props.children.includes("Download")).props
        .disabled,
    ).toBe(true);
    props = { ...props, images: [{ name: "waiting.png", src: "", loading: false }, images[1]!] };
    expect(find((e) => e.props.role === "status").props.children).toBe(
      "This image could not be loaded.",
    );
    action("Next image");
    expect(image().props.src).toBe(images[1]!.src);
  });
});

describe("video galleries", () => {
  beforeEach(() => {
    props = {
      ...props,
      images: [
        images[0]!,
        {
          kind: "video",
          name: "demo.mp4",
          src: "https://remote.example/api/assets/demo.mp4?token=video",
        },
        images[1]!,
      ],
    };
  });

  it("renders a video with playback controls and removes it when navigating to an image", () => {
    const video = find((e) => e.type === "video");
    expect(video.props).toMatchObject({ controls: true, playsInline: true, preload: "metadata" });
    expect(visitElements(render(), (e) => e.props.label === "Zoom in")).toBeNull();
    action("Next media");
    expect(visitElements(render(), (e) => e.type === "video")).toBeNull();
    expect(image().props.src).toBe(images[1]!.src);
    action("Previous media");
    expect(find((e) => e.type === "video").key).toBe(props.images[1]!.src);
  });

  it("leaves playback keyboard shortcuts to the video controls", () => {
    const popup = find((e) => e.props["aria-label"] === "Media viewer");
    const preventDefault = vi.fn();
    (popup.props.onKeyDown as (event: unknown) => void)({
      target: { tagName: "VIDEO" },
      key: "ArrowRight",
      preventDefault,
      stopPropagation: vi.fn(),
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(find((e) => e.type === "video").props.src).toBe(props.images[1]!.src);
  });

  it("still offers the original download when a codec cannot be played", () => {
    (find((e) => e.type === "video").props.onError as () => void)();
    expect(find((e) => e.props.role === "status").props.children).toBe(
      "This video could not be loaded.",
    );
    const download = find(
      (e) => Array.isArray(e.props.children) && e.props.children.includes("Download"),
    );
    expect(download.props.disabled).toBeFalsy();
    (download.props.onClick as () => void)();
    expect(downloadImageFile).toHaveBeenCalledWith(props.images[1]!.src, "demo.mp4");
    expect(
      visitElements(
        render(),
        (e) => Array.isArray(e.props.children) && e.props.children.includes("Copy"),
      ),
    ).toBeNull();
  });
});
