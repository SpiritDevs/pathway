import type { DesktopPreviewAnnotationTheme } from "@spiritdevs/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createNativeBrowserOverlay } from "./NativeBrowserOverlay.ts";

const theme = {
  colorScheme: "dark",
  primary: "#123456",
  background: "#000",
  popover: "#222",
  popoverForeground: "#eee",
  border: "#444",
  fontSans: "system-ui",
} as DesktopPreviewAnnotationTheme;

describe("native browser feedback", () => {
  const elements: Array<ReturnType<typeof makeElement>> = [];
  function makeElement(tag: string) {
    const properties = new Map<string, string>();
    const attributes = new Map<string, string>();
    const element = {
      tag,
      properties,
      attributes,
      className: "",
      textContent: "",
      isConnected: false,
      style: {
        cssText: "",
        display: "",
        transform: "",
        colorScheme: "",
        setProperty: (name: string, value: string) => {
          properties.set(name, value);
        },
      },
      setAttribute: (name: string, value: string) => {
        attributes.set(name, value);
      },
      append: vi.fn(),
      attachShadow: vi.fn(() => ({ append: vi.fn() })),
      showPopover: vi.fn(),
    };
    return element;
  }

  beforeEach(() => {
    elements.length = 0;
    vi.useFakeTimers();
    const createElement = (tag: string) => {
      const element = makeElement(tag);
      elements.push(element);
      return element;
    };
    vi.stubGlobal("document", {
      createElement,
      createElementNS: (_namespace: string, tag: string) => createElement(tag),
      documentElement: {
        append: (element: ReturnType<typeof makeElement>) => {
          element.isConnected = true;
        },
      },
    });
    vi.stubGlobal("window", { setTimeout, clearTimeout });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("uses guest coordinates without intercepting input or continuously scheduling frames", () => {
    const overlay = createNativeBrowserOverlay();
    overlay.update({ kind: "pointer", x: 120, y: 80, scale: 0.5, theme });
    const host = elements.find((element) =>
      element.attributes.has("data-pathway-native-browser-overlay"),
    );
    const cursor = elements.find((element) => element.className === "cursor");
    expect(cursor?.style.transform).toBe("translate(120px, 80px)");
    expect(host?.properties.get("--inverse-scale")).toBe("2");
    expect(host?.properties.get("--primary")).toBe(theme.primary);
    expect(host?.attributes.get("aria-hidden")).toBe("true");
    expect(host?.style.cssText).toContain("pointer-events:none");
    expect(host?.showPopover).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the latest zoom visible for 1.5 seconds without an older timer hiding it", () => {
    const overlay = createNativeBrowserOverlay();
    overlay.update({ kind: "appearance", scale: 1, theme });
    const zoom = elements.find((element) => element.className === "zoom");
    expect(zoom?.textContent).toBe("");
    expect(vi.getTimerCount()).toBe(0);
    overlay.update({ kind: "zoom", zoomFactor: 1.1, scale: 1.1, theme });
    vi.advanceTimersByTime(1000);
    overlay.update({ kind: "zoom", zoomFactor: 1.25, scale: 1.25, theme });
    expect(zoom?.textContent).toBe("125%");
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(500);
    expect(zoom?.style.display).toBe("block");
    vi.advanceTimersByTime(1000);
    expect(zoom?.style.display).toBe("none");
    expect(vi.getTimerCount()).toBe(0);
  });
});
