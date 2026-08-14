/**
 * Getting an image out of the viewer. Both paths re-fetch the asset URL rather than
 * reading the rendered element, so the bytes the user gets are the original ones.
 */

async function fetchImageBlob(src: string): Promise<Blob> {
  const response = await fetch(src);
  if (!response.ok) throw new Error("The image could not be loaded.");
  return response.blob();
}

/** Clipboards only take PNG reliably, so anything else is re-encoded first. */
async function fetchPngBlob(src: string): Promise<Blob> {
  const blob = await fetchImageBlob(src);
  if (blob.type === "image/png") return blob;

  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("This image could not be converted for the clipboard.");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();

  const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (png === null) throw new Error("This image could not be converted for the clipboard.");
  return png;
}

/**
 * Saves the image through a blob URL. A plain `download` anchor is ignored for the
 * cross-origin asset URLs a remote environment serves, so the bytes come local first.
 */
export async function downloadImageFile(src: string, fileName: string): Promise<void> {
  const blob = await fetchImageBlob(src);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export async function copyImageToClipboard(src: string): Promise<void> {
  if (typeof ClipboardItem === "undefined" || navigator.clipboard?.write === undefined) {
    throw new Error("This browser cannot copy images to the clipboard.");
  }
  // Safari only honours a write whose ClipboardItem was built during the click, so the
  // fetch is handed over as a promise instead of being awaited first.
  await navigator.clipboard.write([new ClipboardItem({ "image/png": fetchPngBlob(src) })]);
}
