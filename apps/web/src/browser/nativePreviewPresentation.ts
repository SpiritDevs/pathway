import type { DesktopPreviewPresentationBounds } from "@spiritdevs/contracts";

const OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[role="tooltip"]',
  '[data-slot="popover-popup"]',
  '[data-slot$="-backdrop"]',
].join(",");

export function overlapsNativePreview(
  bounds: DesktopPreviewPresentationBounds,
  overlay: Pick<DOMRect, "x" | "y" | "width" | "height">,
): boolean {
  return (
    overlay.width > 0 &&
    overlay.height > 0 &&
    overlay.x < bounds.x + bounds.width &&
    overlay.x + overlay.width > bounds.x &&
    overlay.y < bounds.y + bounds.height &&
    overlay.y + overlay.height > bounds.y
  );
}

/** Native views paint above the renderer. Hide them while an app popup covers their panel. */
export function observeNativePreviewOverlays(
  bounds: DesktopPreviewPresentationBounds,
  present: (bounds: DesktopPreviewPresentationBounds | null) => void,
): () => void {
  let lastVisible: boolean | undefined;
  let frame: number | null = null;
  const refresh = () => {
    frame = null;
    const visible = !Array.from(document.querySelectorAll(OVERLAY_SELECTOR)).some((overlay) => {
      if (overlay.closest('[hidden], [data-closed], [aria-hidden="true"]')) return false;
      return overlapsNativePreview(bounds, overlay.getBoundingClientRect());
    });
    if (visible === lastVisible) return;
    lastVisible = visible;
    present(visible ? bounds : null);
  };
  const schedule = () => {
    if (frame === null) frame = requestAnimationFrame(refresh);
  };
  const containsOverlay = (node: Node) =>
    node instanceof Element &&
    (node.matches(OVERLAY_SELECTOR) || node.querySelector(OVERLAY_SELECTOR) !== null);
  const observer = new MutationObserver((records) => {
    if (
      records.some((record) =>
        record.type === "attributes"
          ? containsOverlay(record.target)
          : Array.from(record.addedNodes).some(containsOverlay) ||
            Array.from(record.removedNodes).some(containsOverlay),
      )
    ) {
      schedule();
    }
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["data-open", "data-closed", "hidden", "aria-hidden", "data-starting-style"],
  });
  refresh();
  return () => {
    observer.disconnect();
    if (frame !== null) cancelAnimationFrame(frame);
    present(null);
  };
}
