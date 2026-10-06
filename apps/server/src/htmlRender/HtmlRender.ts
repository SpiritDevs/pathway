import type { ThreadId, HtmlRenderReference, HtmlPreviewMetadata } from "@spiritdevs/contracts";
import {
  clampHtmlRenderHeight,
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MEASURE_FONTS,
  HTML_RENDER_MEASURE_WIDTHS,
  htmlRenderTheme,
  htmlRenderThemeFragment,
  injectHtmlRenderBootstrap,
} from "@spiritdevs/shared/htmlRender";
import {
  Pathway_CODE_DARK_THEME_COLORS,
  Pathway_CODE_LIGHT_THEME_COLORS,
  type ThemeAppearance,
} from "@spiritdevs/shared/themePalettes";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { createAttachmentId, parseThreadSegmentFromAttachmentId } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import { HtmlPreviewBrowser, HtmlRenderBrowserError } from "./HtmlPreviewBrowser.ts";

const MIB = 1024 * 1024;
export const MAX_HTML_CHARACTERS = 512_000;
export const MAX_IMAGE_BYTES = 10 * MIB;
export const MAX_PAGE_BYTES = 25 * MIB;
const formatMib = (bytes: number) => `${(bytes / MIB).toFixed(1)} MiB`;

export class HtmlRenderHtmlTooLargeError extends Schema.TaggedErrorClass<HtmlRenderHtmlTooLargeError>()(
  "HtmlRenderHtmlTooLargeError",
  { characters: Schema.Number },
) {
  override get message(): string {
    return `HTML must be at most ${MAX_HTML_CHARACTERS} characters (received ${this.characters}).`;
  }
}
export class HtmlRenderImagesNotFoundError extends Schema.TaggedErrorClass<HtmlRenderImagesNotFoundError>()(
  "HtmlRenderImagesNotFoundError",
  { paths: Schema.Array(Schema.String) },
) {
  override get message(): string {
    return `These local images could not be read or are not supported images: ${this.paths.join(", ")}. Use absolute paths to existing image files, or remove them.`;
  }
}
export class HtmlRenderImageTooLargeError extends Schema.TaggedErrorClass<HtmlRenderImageTooLargeError>()(
  "HtmlRenderImageTooLargeError",
  { path: Schema.String, sizeBytes: Schema.Number },
) {
  override get message(): string {
    return `${this.path} is ${formatMib(this.sizeBytes)}; each local image must be at most ${formatMib(MAX_IMAGE_BYTES)}.`;
  }
}
export class HtmlRenderPageTooLargeError extends Schema.TaggedErrorClass<HtmlRenderPageTooLargeError>()(
  "HtmlRenderPageTooLargeError",
  { sizeBytes: Schema.Number },
) {
  override get message(): string {
    return `With its images inlined the page is ${formatMib(this.sizeBytes)}; the limit is ${formatMib(MAX_PAGE_BYTES)}. Use smaller images.`;
  }
}
export class HtmlRenderStoreError extends Schema.TaggedErrorClass<HtmlRenderStoreError>()(
  "HtmlRenderStoreError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The HTML render could not be saved or discarded.";
  }
}
export type HtmlRenderPrepareError =
  | HtmlRenderHtmlTooLargeError
  | HtmlRenderImagesNotFoundError
  | HtmlRenderImageTooLargeError
  | HtmlRenderPageTooLargeError;
export interface HtmlPreview {
  readonly png: Uint8Array;
  readonly metadata: HtmlPreviewMetadata;
}
export interface HtmlPublishInput {
  readonly threadId: ThreadId;
  readonly html: string;
  readonly title: string;
  readonly height: number;
}
export interface HtmlPreviewInput {
  readonly html: string;
  readonly width?: number | undefined;
  readonly appearance?: ThemeAppearance | undefined;
}

/** MCP callers must recheck live thread/run authorization after publish, discarding
 * the returned attachment on rejection. Keep that check and discard under an
 * interruption finalizer as well. The service cleans up until publish returns.
 */
export class HtmlRender extends Context.Service<
  HtmlRender,
  {
    readonly prepare: (html: string) => Effect.Effect<string, HtmlRenderPrepareError>;
    readonly publish: (
      input: HtmlPublishInput,
    ) => Effect.Effect<HtmlRenderReference, HtmlRenderPrepareError | HtmlRenderStoreError>;
    readonly preview: (
      input: HtmlPreviewInput,
    ) => Effect.Effect<HtmlPreview, HtmlRenderPrepareError | HtmlRenderBrowserError>;
    readonly discardHtmlRender: (
      reference: HtmlRenderReference,
    ) => Effect.Effect<void, HtmlRenderStoreError>;
  }
>()("@spiritdevs/pathway/htmlRender/HtmlRender") {}

const IMAGE_MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  ico: "image/x-icon",
};
const IMAGE_EXTENSIONS = Object.keys(IMAGE_MIME_TYPES).join("|");
// POSIX `/…` (not protocol-relative `//…`, nor `/\…`, which Windows reads as a
// UNC share and would reach over SMB) or Windows `C:\…` / `C:/…`.
const ABSOLUTE_PATH = String.raw`(?:/(?![/\\])|[a-z]:[\\/])`;
// An absolute image path that is a whole quoted string ("…", '…', `…`) or an
// unquoted CSS url(…). URLs, data:, blob:, and relative paths never match.
const LOCAL_IMAGE_PATTERN = new RegExp(
  String.raw`(["'\x60])(${ABSOLUTE_PATH}(?:(?!\1)[^\r\n]){0,2048}?\.(?:${IMAGE_EXTENSIONS}))\1` +
    String.raw`|url\(\s*(${ABSOLUTE_PATH}[^\s"'\x60()]{0,2048}?\.(?:${IMAGE_EXTENSIONS}))\s*\)`,
  "gid",
);

const findLocalImages = (html: string) =>
  Array.from(html.matchAll(LOCAL_IMAGE_PATTERN)).flatMap((match) => {
    const span = match.indices?.[2] ?? match.indices?.[3];
    return span ? [{ start: span[0], end: span[1], path: html.slice(span[0], span[1]) }] : [];
  });

// Inside a JS string literal a Windows path's backslashes are escaped.
const filePathFor = (reference: string) =>
  /^[a-z]:/i.test(reference) ? reference.replaceAll("\\\\", "\\") : reference;

const dataUriPrefix = (path: string) =>
  `data:${IMAGE_MIME_TYPES[path.slice(path.lastIndexOf(".") + 1).toLowerCase()] ?? "application/octet-stream"};base64,`;

const latin1 = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/**
 * Whether file bytes are an image, whatever the file is named, so a symlink or
 * renamed file cannot carry other data, such as a secret, into a page.
 */
const isImageBytes = (bytes: Uint8Array) => {
  const head = latin1(bytes, 0, 12);
  if (
    head.startsWith("\x89PNG\r\n\x1a\n") ||
    head.startsWith("\xff\xd8\xff") ||
    head.startsWith("GIF87a") ||
    head.startsWith("GIF89a") ||
    head.startsWith("\0\0\x01\0") ||
    (head.startsWith("BM") && head.slice(6, 10) === "\0\0\0\0") ||
    (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") ||
    /^ftyp(?:avif|avis|mif1)$/.test(head.slice(4, 12))
  ) {
    return true;
  }
  return hasSvgRoot(new TextDecoder().decode(bytes.subarray(0, 4096)));
};

/** The index just past `token` at or after `from`, or -1 when it never appears. */
const after = (text: string, token: string, from: number) => {
  const at = text.indexOf(token, from);
  return at === -1 ? -1 : at + token.length;
};

/**
 * Whether an XML document's root element is <svg>, after any processing
 * instructions, comments, and a doctype. One forward pass, so no input can
 * make it slow, and quoted text never counts as markup.
 */
const hasSvgRoot = (text: string) => {
  let at = 0;
  while (at !== -1) {
    while (/\s/.test(text.charAt(at))) at += 1;
    if (text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (text.slice(at, at + 9).toLowerCase() === "<!doctype") at = afterDoctype(text, at + 9);
    // XML names are case-sensitive, and only these characters can end one here.
    else return /^<svg[ \t\r\n/>]/.test(text.slice(at, at + 5));
  }
  return false;
};

/** The index just past a doctype whose body starts at `from`, honoring quotes and its internal subset. */
const afterDoctype = (text: string, from: number) => {
  let inSubset = false;
  let at = from;
  while (at !== -1 && at < text.length) {
    const char = text[at];
    if (char === '"' || char === "'") at = after(text, char, at + 1);
    else if (inSubset && text.startsWith("<!--", at)) at = after(text, "-->", at + 4);
    else if (inSubset && text.startsWith("<?", at)) at = after(text, "?>", at + 2);
    else if (char === ">" && !inSubset) return at + 1;
    else {
      if (char === "[") inSubset = true;
      else if (char === "]") inSubset = false;
      at += 1;
    }
  }
  return -1;
};

/** Replaces every local image reference with a data URI; unreadable paths stay as written. */
const inlineLocalImages = Effect.fn("HtmlRender.inlineLocalImages")(function* (html: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const references = findLocalImages(html);
  const files = yield* Effect.forEach(
    [...new Set(references.map((reference) => reference.path))],
    (path) =>
      fileSystem.stat(filePathFor(path)).pipe(
        Effect.map((info) => ({
          path,
          size: info.type === "File" ? Number(info.size) : undefined,
        })),
        Effect.orElseSucceed(() => ({ path, size: undefined })),
      ),
    { concurrency: 8 },
  );
  const oversized = files.find((file) => file.size !== undefined && file.size > MAX_IMAGE_BYTES);
  if (oversized?.size !== undefined) {
    return yield* new HtmlRenderImageTooLargeError({
      path: oversized.path,
      sizeBytes: oversized.size,
    });
  }
  const sizes = new Map(files.map((file) => [file.path, file.size]));
  const pageBytes = references.reduce((total, reference) => {
    const size = sizes.get(reference.path);
    return size === undefined
      ? total
      : total +
          dataUriPrefix(reference.path).length +
          Math.ceil(size / 3) * 4 -
          Buffer.byteLength(reference.path);
  }, Buffer.byteLength(html));
  if (pageBytes > MAX_PAGE_BYTES) {
    return yield* new HtmlRenderPageTooLargeError({ sizeBytes: pageBytes });
  }
  // Files can grow after `stat`. Each read stops one byte past the image
  // limit, and reading stops once the images read so far cannot fit the page.
  let readBytes = 0;
  const images = yield* Effect.forEach(
    files.filter((file) => file.size !== undefined),
    (file) =>
      Effect.gen(function* () {
        const read = yield* fileSystem
          .stream(filePathFor(file.path), { bytesToRead: MAX_IMAGE_BYTES + 1 })
          .pipe(Stream.mkUint8Array, Effect.option);
        if (Option.isNone(read)) return [];
        const bytes = read.value;
        if (bytes.byteLength > MAX_IMAGE_BYTES) {
          return yield* new HtmlRenderImageTooLargeError({
            path: file.path,
            sizeBytes: bytes.byteLength,
          });
        }
        if (!isImageBytes(bytes)) return [];
        readBytes += Math.ceil(bytes.byteLength / 3) * 4;
        if (readBytes > MAX_PAGE_BYTES) {
          return yield* new HtmlRenderPageTooLargeError({ sizeBytes: readBytes });
        }
        return [{ path: file.path, bytes }];
      }),
    { concurrency: 4 },
  ).pipe(Effect.map((entries) => entries.flat()));
  const dataUris = new Map(
    images.map(
      (image) =>
        // Node's encoder: images run to 10 MiB.
        [
          image.path,
          dataUriPrefix(image.path) + Buffer.from(image.bytes).toString("base64"),
        ] as const,
    ),
  );
  // Recheck every occurrence with the bytes actually read. A small stat followed
  // by growth must not allocate a giant repeated expansion before the final check.
  const actualPageBytes = references.reduce((total, reference) => {
    const uri = dataUris.get(reference.path);
    return uri === undefined ? total : total + uri.length - Buffer.byteLength(reference.path);
  }, Buffer.byteLength(html));
  if (actualPageBytes > MAX_PAGE_BYTES) {
    return yield* new HtmlRenderPageTooLargeError({ sizeBytes: actualPageBytes });
  }
  const parts: Array<string> = [];
  let cursor = 0;
  for (const reference of references) {
    const dataUri = dataUris.get(reference.path);
    if (dataUri === undefined) continue;
    parts.push(html.slice(cursor, reference.start), dataUri);
    cursor = reference.end;
  }
  parts.push(html.slice(cursor));
  const inlined = parts.join("");
  const inlinedBytes = Buffer.byteLength(inlined);
  if (inlinedBytes > MAX_PAGE_BYTES) {
    return yield* new HtmlRenderPageTooLargeError({ sizeBytes: inlinedBytes });
  }
  return {
    html: inlined,
    missing: files.filter((file) => !dataUris.has(file.path)).map((file) => file.path),
  };
});

const MEASURE_FRAGMENT = htmlRenderThemeFragment(
  htmlRenderTheme(Pathway_CODE_DARK_THEME_COLORS, "dark", HTML_RENDER_MEASURE_FONTS),
);

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const browser = yield* HtmlPreviewBrowser;
  const browsers = yield* Semaphore.make(2);

  const inline = Effect.fn("HtmlRender.inline")(function* (html: string) {
    if (html.length > MAX_HTML_CHARACTERS)
      return yield* new HtmlRenderHtmlTooLargeError({ characters: html.length });
    return yield* inlineLocalImages(injectHtmlRenderBootstrap(html)).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
    );
  });
  const prepare = Effect.fn("HtmlRender.prepare")(function* (html: string) {
    const inlined = yield* inline(html);
    if (inlined.missing.length > 0)
      return yield* new HtmlRenderImagesNotFoundError({ paths: inlined.missing });
    return inlined.html;
  });

  // The entire operation, including waiting for a browser permit, has a deadline.
  const measure = Effect.fn("HtmlRender.measure")(
    function* (html: string) {
      if (!(yield* browser.available)) return undefined;
      const heights = yield* browsers.withPermits(1)(
        browser.measure({
          html,
          widths: HTML_RENDER_MEASURE_WIDTHS,
          urlFragment: MEASURE_FRAGMENT,
        }),
      );
      return heights.toSorted(([left], [right]) => left - right);
    },
    Effect.timeoutOrElse({ duration: "6 seconds", orElse: () => Effect.succeed(undefined) }),
    Effect.catch((cause) =>
      Effect.logWarning("Could not measure an HTML render; publishing it without heights.", {
        cause,
      }).pipe(Effect.as(undefined)),
    ),
  );

  const publish = Effect.fn("HtmlRender.publish")(function* (input: HtmlPublishInput) {
    const html = yield* prepare(input.html);
    const attachmentId = createAttachmentId(input.threadId, "html");
    const filePath =
      attachmentId === null
        ? null
        : resolveAttachmentRelativePath({
            attachmentsDir: config.attachmentsDir,
            relativePath: `${attachmentId}.html`,
          });
    if (attachmentId === null || filePath === null)
      return yield* new HtmlRenderStoreError({ cause: new Error("Invalid thread id.") });
    // Include the final reference construction in the cleanup boundary.
    return yield* Effect.gen(function* () {
      yield* fileSystem
        .writeFileString(filePath, html)
        .pipe(Effect.mapError((cause) => new HtmlRenderStoreError({ cause })));
      const heights = yield* measure(html);
      return {
        attachmentId,
        title: input.title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) || "HTML",
        height: clampHtmlRenderHeight(input.height),
        ...(heights === undefined ? {} : { heights }),
      } satisfies HtmlRenderReference;
    }).pipe(Effect.onError(() => fileSystem.remove(filePath, { force: true }).pipe(Effect.ignore)));
  });

  const discardHtmlRender = Effect.fn("HtmlRender.discardHtmlRender")(function* (
    reference: HtmlRenderReference,
  ) {
    // Accept only this service's flat HTML namespace; never delete an arbitrary path.
    const filePath =
      reference.attachmentId.endsWith("-html") &&
      parseThreadSegmentFromAttachmentId(reference.attachmentId) !== null
        ? resolveAttachmentRelativePath({
            attachmentsDir: config.attachmentsDir,
            relativePath: `${reference.attachmentId}.html`,
          })
        : null;
    if (filePath === null)
      return yield* new HtmlRenderStoreError({ cause: new Error("Invalid HTML attachment id.") });
    yield* fileSystem
      .remove(filePath, { force: true })
      .pipe(Effect.mapError((cause) => new HtmlRenderStoreError({ cause })));
  });

  const preview = Effect.fn("HtmlRender.preview")(function* (input: HtmlPreviewInput) {
    const width = Math.min(
      1600,
      Math.max(
        240,
        Math.round(Number.isFinite(input.width) ? input.width! : HTML_RENDER_COLUMN_WIDTH),
      ),
    );
    const appearance = input.appearance ?? "dark";
    const inlined = yield* inline(input.html);
    const theme = htmlRenderTheme(
      appearance === "light" ? Pathway_CODE_LIGHT_THEME_COLORS : Pathway_CODE_DARK_THEME_COLORS,
      appearance,
      HTML_RENDER_MEASURE_FONTS,
    );
    const captured = yield* browsers.withPermits(1)(
      browser.capture({ html: inlined.html, width, urlFragment: htmlRenderThemeFragment(theme) }),
    );
    return {
      png: captured.png,
      metadata: {
        width,
        contentHeight: captured.contentHeight,
        capturedHeight: captured.capturedHeight,
        consoleMessages: captured.consoleMessages,
        ...(inlined.missing.length === 0 ? {} : { missingImages: inlined.missing }),
        screenshot: { mimeType: "image/png", width, height: captured.capturedHeight },
      },
    } satisfies HtmlPreview;
  });
  return HtmlRender.of({ prepare, publish, preview, discardHtmlRender });
});

export const layer = Layer.effect(HtmlRender, make);
