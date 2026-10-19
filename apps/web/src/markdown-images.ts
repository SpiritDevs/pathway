import { defaultUrlTransform } from "react-markdown";

import { normalizeMarkdownLinkDestination, POSIX_FILE_ROOT_PREFIXES } from "./markdown-links";

export type MarkdownImageSource =
  | { readonly kind: "workspace"; readonly path: string }
  | { readonly kind: "web"; readonly url: string }
  | { readonly kind: "unavailable" };

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some(
    (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
}

const WINDOWS_PATH = /^(?:[a-z]:(?:[\\/]|%5c|%2f)|\\\\)/i;

/** Classify image destinations without editor-link line suffixes or client OS path resolution. */
export function resolveMarkdownImageSource(source: string, cwd?: string): MarkdownImageSource {
  const value = normalizeMarkdownLinkDestination(source);
  if (!value || hasControlCharacters(value)) return { kind: "unavailable" };
  if (/^(?:https?:)?\/\//i.test(value)) {
    return { kind: "web", url: defaultUrlTransform(value) };
  }
  let path: string;
  let explicitFile = false;
  try {
    if (/^file:/i.test(value)) {
      const file = new URL(value);
      if (file.username || file.password || file.port) return { kind: "unavailable" };
      path = decodeURIComponent(file.pathname);
      if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
      if (file.hostname && file.hostname !== "localhost") path = `//${file.hostname}${path}`;
      explicitFile = true;
    } else {
      if (!WINDOWS_PATH.test(value) && /^[a-z][a-z0-9+.-]*:/i.test(value)) {
        return { kind: "unavailable" };
      }
      // Decode once, after removing URL suffixes. Encoded #, ?, and % belong to the filename.
      path = decodeURIComponent(value.split(/[?#]/, 1)[0] ?? "");
    }
  } catch {
    return { kind: "unavailable" };
  }
  if (!path || hasControlCharacters(path)) return { kind: "unavailable" };
  const root = cwd?.replace(/\/$/, "");
  if (
    !explicitFile &&
    path.startsWith("/") &&
    !WINDOWS_PATH.test(path) &&
    !POSIX_FILE_ROOT_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
    !(root && path.startsWith(`${root}/`))
  ) {
    return { kind: "web", url: defaultUrlTransform(value) };
  }
  return { kind: "workspace", path };
}

/** These protocols reach only our image component, which never puts them directly into img.src. */
export function markdownImageUrlTransform(source: string): string {
  return /^(?:file:|sandbox:)/i.test(source) || WINDOWS_PATH.test(source)
    ? source
    : defaultUrlTransform(source);
}
