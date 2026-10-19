import { describe, expect, it } from "vite-plus/test";

import {
  clampPanOffset,
  imageDownloadFileName,
  MAX_IMAGE_ZOOM,
  MIN_IMAGE_ZOOM,
  steppedZoom,
  wrapImageIndex,
} from "./imageLightbox.logic";

describe("image lightbox navigation", () => {
  it("wraps past both ends of the gallery", () => {
    expect(wrapImageIndex(3, 3)).toBe(0);
    expect(wrapImageIndex(-1, 3)).toBe(2);
    expect(wrapImageIndex(-4, 3)).toBe(2);
    expect(wrapImageIndex(1, 3)).toBe(1);
  });

  it("stays on the first slot when there is nothing to show", () => {
    expect(wrapImageIndex(2, 0)).toBe(0);
  });
});

describe("image lightbox zoom", () => {
  it("walks the discrete stops in both directions", () => {
    expect(steppedZoom(1, 1)).toBe(1.5);
    expect(steppedZoom(1.5, 1)).toBe(2);
    expect(steppedZoom(2, -1)).toBe(1.5);
  });

  it("clamps at the ends instead of running away", () => {
    expect(steppedZoom(MAX_IMAGE_ZOOM, 1)).toBe(MAX_IMAGE_ZOOM);
    expect(steppedZoom(MIN_IMAGE_ZOOM, -1)).toBe(MIN_IMAGE_ZOOM);
  });

  it("keeps panning inside the overflow the zoom produced", () => {
    expect(clampPanOffset(400, 200)).toBe(100);
    expect(clampPanOffset(-400, 200)).toBe(-100);
    expect(clampPanOffset(30, 200)).toBe(30);
    expect(clampPanOffset(30, 0)).toBe(0);
  });
});

describe("image download names", () => {
  it("keeps a name that already has an extension", () => {
    expect(imageDownloadFileName("screenshot.png", "https://host/a.jpg")).toBe("screenshot.png");
  });

  it("borrows the extension from the source url", () => {
    expect(imageDownloadFileName("Issue attachment 1", "https://host/assets/abc.webp?sig=1")).toBe(
      "Issue-attachment-1.webp",
    );
  });

  it("reads data url mime types", () => {
    expect(imageDownloadFileName("Pasted image", "data:image/jpeg;base64,AAAA")).toBe(
      "Pasted-image.jpg",
    );
  });

  it("falls back to png when the source says nothing", () => {
    expect(imageDownloadFileName("Pasted image", "blob:http://localhost/9f2")).toBe(
      "Pasted-image.png",
    );
  });

  it("never produces an empty filename", () => {
    expect(imageDownloadFileName("   ", "blob:http://localhost/9f2")).toBe("image.png");
  });
});
