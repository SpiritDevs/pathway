import type { DesktopPreviewAnnotationTheme } from "@spiritdevs/contracts";

export type NativeBrowserOverlayAction =
  | { readonly kind: "appearance" }
  | { readonly kind: "hide-pointer" }
  | { readonly kind: "pointer"; readonly x: number; readonly y: number }
  | { readonly kind: "zoom"; readonly zoomFactor: number };

export type NativeBrowserOverlayUpdate = NativeBrowserOverlayAction & {
  readonly theme: DesktopPreviewAnnotationTheme;
  readonly scale: number;
};

/** Native popup contents paint above the app renderer, so their feedback lives in the guest. */
export function createNativeBrowserOverlay() {
  const host = document.createElement("div");
  host.setAttribute("data-pathway-native-browser-overlay", "");
  host.setAttribute("data-pathway-annotation-ui", "");
  host.setAttribute("aria-hidden", "true");
  host.popover = "manual";
  host.style.cssText =
    "all:initial;position:fixed;inset:0;width:auto;height:auto;margin:0;border:0;padding:0;background:transparent;overflow:visible;pointer-events:none;z-index:2147483645";
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `
    :host { --inverse-scale: 1; }
    .cursor { position:absolute;left:0;top:0;display:none;opacity:.8;pointer-events:none;transition:transform 160ms ease-out; }
    svg { display:block;width:24px;height:24px;transform:scale(var(--inverse-scale));transform-origin:top left;fill:var(--primary);stroke:var(--background);stroke-width:1.5;filter:drop-shadow(0 2px 2px #0005); }
    .zoom { display:none;position:absolute;top:calc(12px * var(--inverse-scale));right:calc(12px * var(--inverse-scale));transform:scale(var(--inverse-scale));transform-origin:top right;border:1px solid var(--border);border-radius:999px;padding:4px 10px;background:var(--popover);color:var(--foreground);font:500 12px/16px var(--font);box-shadow:0 2px 8px #0002;pointer-events:none; }
    @media (prefers-reduced-motion: reduce) { .cursor { transition:none; } }
  `;
  const cursor = document.createElement("div");
  cursor.className = "cursor";
  const arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  arrow.setAttribute("viewBox", "0 0 24 24");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M4 3 20 11 13 13 11 20 4 3Z");
  path.setAttribute("stroke-linejoin", "round");
  arrow.append(path);
  cursor.append(arrow);
  const zoom = document.createElement("div");
  zoom.className = "zoom";
  root.append(style, cursor, zoom);
  let hideZoom: number | undefined;

  const setTheme = (theme: DesktopPreviewAnnotationTheme) => {
    host.style.colorScheme = theme.colorScheme;
    host.style.setProperty("--primary", theme.primary);
    host.style.setProperty("--background", theme.background);
    host.style.setProperty("--popover", theme.popover);
    host.style.setProperty("--foreground", theme.popoverForeground);
    host.style.setProperty("--border", theme.border);
    host.style.setProperty("--font", theme.fontSans);
  };

  const update = (message: NativeBrowserOverlayUpdate) => {
    if (!document.documentElement) return;
    if (!host.isConnected) {
      document.documentElement.append(host);
      host.showPopover();
    }
    setTheme(message.theme);
    const scale = Number.isFinite(message.scale) && message.scale > 0 ? message.scale : 1;
    host.style.setProperty("--inverse-scale", String(1 / scale));
    if (message.kind === "hide-pointer") {
      cursor.style.display = "none";
    } else if (message.kind === "pointer") {
      cursor.style.display = "block";
      // Pointer events already use guest CSS coordinates; Chromium applies viewport scaling.
      cursor.style.transform = `translate(${message.x}px, ${message.y}px)`;
    } else if (message.kind === "zoom") {
      zoom.textContent = `${Math.round(message.zoomFactor * 100)}%`;
      zoom.style.display = "block";
      if (hideZoom !== undefined) window.clearTimeout(hideZoom);
      hideZoom = window.setTimeout(() => {
        zoom.style.display = "none";
        hideZoom = undefined;
      }, 1500);
    }
  };

  return { update, setTheme };
}
