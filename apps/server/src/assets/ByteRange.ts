/** Resolves a single HTTP byte range without allocating the requested media. */
export function resolveByteRange(
  header: string | undefined,
  size: number,
):
  | { readonly status: 200 }
  | { readonly status: 206; readonly start: number; readonly length: number }
  | { readonly status: 416 } {
  if (header === undefined) return { status: 200 };
  // Unsupported units and multipart requests may be ignored by an HTTP server.
  if (!header.startsWith("bytes=") || header.includes(",")) return { status: 200 };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2]) || size === 0) return { status: 416 };
  const first = match[1] ? Number(match[1]) : undefined;
  const last = match[2] ? Number(match[2]) : undefined;
  if (
    (first !== undefined && !Number.isSafeInteger(first)) ||
    (last !== undefined && !Number.isSafeInteger(last))
  )
    return { status: 416 };
  if (first === undefined) {
    if (!last) return { status: 416 };
    const length = Math.min(size, last);
    return { status: 206, start: size - length, length };
  }
  if (first >= size || (last !== undefined && last < first)) return { status: 416 };
  return { status: 206, start: first, length: Math.min(last ?? size - 1, size - 1) - first + 1 };
}
