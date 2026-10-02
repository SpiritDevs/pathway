/** Metadata can be missing on dropped files, so also inspect the HEIF container header. */
export async function isHeicImage(file: File): Promise<boolean> {
  if (/^image\/(heic|heif)(-sequence)?$/i.test(file.type) || /\.(heic|heif|hif)$/i.test(file.name))
    return true;
  const header = new Uint8Array(await file.slice(0, 256).arrayBuffer());
  const brand = (offset: number) => String.fromCharCode(...header.subarray(offset, offset + 4));
  if (brand(4) !== "ftyp") return false;
  const size = new DataView(header.buffer).getUint32(0);
  const brands = [brand(8)];
  for (let offset = 16; offset + 4 <= Math.min(size, header.length); offset += 4)
    brands.push(brand(offset));
  // AVIF also uses mif1, but does not need the HEVC decoder.
  if (brands.includes("avif") || brands.includes("avis")) return false;
  return brands.some((value) =>
    /^(heic|heix|hevc|hevx|heim|heis|hevm|hevs|mif1|msf1)$/.test(value),
  );
}

/** The CSP build decodes in a worker; loading it only for HEIF keeps normal chat startup light. */
export async function decodeHeicImage(file: File): Promise<ImageBitmap> {
  const { heicTo } = await import("heic-to/csp");
  return heicTo({ blob: file, type: "bitmap" });
}
