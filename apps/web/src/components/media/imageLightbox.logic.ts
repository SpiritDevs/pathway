/**
 * Pure helpers behind the in-app image viewer. Navigation, zoom stepping, and
 * download naming live here so the dialog itself stays a thin render layer.
 */

/** Discrete zoom stops. Index 0 is "fit to the viewport", everything above is a magnification. */
export const IMAGE_ZOOM_STEPS = [1, 1.5, 2, 3, 4] as const;

export const MIN_IMAGE_ZOOM = IMAGE_ZOOM_STEPS[0];
export const MAX_IMAGE_ZOOM = IMAGE_ZOOM_STEPS[IMAGE_ZOOM_STEPS.length - 1] ?? MIN_IMAGE_ZOOM;

/** Slideshow navigation wraps, so arrowing past the last image lands back on the first. */
export function wrapImageIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

/** Moves one stop along {@link IMAGE_ZOOM_STEPS}, clamped at both ends. */
export function steppedZoom(zoom: number, direction: -1 | 1): number {
  const steps = IMAGE_ZOOM_STEPS;
  if (direction === 1) {
    return steps.find((step) => step > zoom + 0.001) ?? MAX_IMAGE_ZOOM;
  }
  let previous: number = MIN_IMAGE_ZOOM;
  for (const step of steps) {
    if (step < zoom - 0.001) previous = step;
  }
  return previous;
}

/** Keeps a pan offset inside the overflow the current zoom actually produces. */
export function clampPanOffset(offset: number, overflow: number): number {
  const limit = Math.max(0, overflow) / 2;
  return Math.min(limit, Math.max(-limit, offset));
}

const EXTENSION_PATTERN = /\.[a-z0-9]{2,5}$/i;
const DATA_URL_MIME_PATTERN = /^data:image\/([a-z0-9+.-]+)/i;
const UNSAFE_FILENAME_CHARACTERS = /[^\w.-]+/g;

/** Extension implied by an asset URL or data URL, without trusting the query string. */
function imageExtensionFromSource(src: string): string | null {
  const dataUrlMime = DATA_URL_MIME_PATTERN.exec(src);
  if (dataUrlMime?.[1]) {
    const subtype = dataUrlMime[1].toLowerCase();
    return subtype === "jpeg" ? "jpg" : subtype === "svg+xml" ? "svg" : subtype;
  }
  const path = src.split(/[?#]/, 1)[0] ?? "";
  const lastSegment = path.split("/").pop() ?? "";
  const extension = EXTENSION_PATTERN.exec(lastSegment)?.[0];
  return extension ? extension.slice(1).toLowerCase() : null;
}

/**
 * Filename for a downloaded image. Attachment display names ("Issue attachment 1")
 * carry no extension, so the source URL supplies one and PNG is the last resort.
 */
export function imageDownloadFileName(name: string, src: string): string {
  const base =
    name
      .trim()
      .replace(UNSAFE_FILENAME_CHARACTERS, "-")
      .replace(/^-+|-+$/g, "") || "image";
  if (EXTENSION_PATTERN.test(base)) return base;
  return `${base}.${imageExtensionFromSource(src) ?? "png"}`;
}
