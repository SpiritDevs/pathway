import * as Predicate from "effect/Predicate";

import { readHtmlRenderReference } from "./htmlRender.ts";
import { resolvePathwayMcpToolId } from "./pathwayMcpToolPresentation.ts";

const MAX_PARSED_BYTES = 16_384;
const MAX_METADATA_BYTES = 8_192;
const MAX_DEPTH = 6;
const MAX_NODES = 64;
const MAX_CONTENT_BLOCKS = 32;
const encoder = new TextEncoder();

export interface ToolOutputEnvelope {
  readonly data: Readonly<Record<string, unknown>> | undefined;
  readonly isError: boolean;
}

/** Reads only bounded MCP result envelopes, including Cursor's nested text.text blocks. */
export function readToolOutput(value: unknown): ToolOutputEnvelope {
  let parsedBytes = 0;
  let nodes = 0;
  let isError = false;
  let exhausted = false;
  let data: Record<string, unknown> | undefined;
  let fallback: Record<string, unknown> | undefined;
  const visited = new Set<object>();

  function visit(current: unknown, depth: number): void {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES) {
      exhausted = true;
      return;
    }
    if (typeof current === "string") {
      // The character guard avoids encoding an unbounded string just to reject it.
      if (current.length > MAX_PARSED_BYTES - parsedBytes) {
        exhausted = true;
        return;
      }
      const bytes = encoder.encode(current).byteLength;
      if (bytes > MAX_PARSED_BYTES - parsedBytes) {
        exhausted = true;
        return;
      }
      parsedBytes += bytes;
      try {
        visit(JSON.parse(current), depth + 1);
      } catch {
        // Ordinary text and malformed JSON are not structured results.
      }
      return;
    }
    if (Array.isArray(current)) {
      if (visited.has(current)) return;
      visited.add(current);
      if (current.length > MAX_CONTENT_BLOCKS) exhausted = true;
      for (const block of current.slice(0, MAX_CONTENT_BLOCKS)) visit(block, depth + 1);
      return;
    }
    if (!Predicate.isObject(current) || visited.has(current)) return;
    visited.add(current);
    if (
      current.isError === true ||
      current.is_error === true ||
      (current.error != null && current.error !== false)
    ) {
      isError = true;
    }
    if (
      current.htmlRender !== undefined ||
      (current.width !== undefined && current.contentHeight !== undefined)
    ) {
      data ??= current;
    } else if (typeof current.message === "string" || current.error != null) {
      fallback ??= current;
    }
    if (typeof current.text === "string") fallback ??= { message: current.text };
    // Prefer the structured mirror; still inspect text mirrors for error flags.
    if (current.structuredContent !== undefined) visit(current.structuredContent, depth + 1);
    if (current.content !== undefined) visit(current.content, depth + 1);
    if (current.text !== undefined) visit(current.text, depth + 1);
  }

  visit(value, 0);
  // An unread branch could carry an error: never promote a partial traversal to success.
  return { data: exhausted ? undefined : (data ?? fallback), isError: isError || exhausted };
}

function boundedText(value: unknown, maxBytes = MAX_METADATA_BYTES): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.slice(0, maxBytes);
  const bytes = encoder.encode(text);
  return bytes.byteLength <= maxBytes
    ? text
    : new TextDecoder().decode(bytes.subarray(0, maxBytes), { stream: true });
}

function boundedJsonText(value: unknown, maxBytes: number): string {
  const text = boundedText(value, maxBytes) ?? "";
  if (encoder.encode(JSON.stringify(text)).byteLength <= maxBytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(JSON.stringify(text.slice(0, middle))).byteLength <= maxBytes) low = middle;
    else high = middle - 1;
  }
  // Do not leave half a surrogate pair at the truncation boundary.
  return text.slice(0, low).replace(/[\uD800-\uDBFF]$/, "");
}

function compactInput(tool: string, value: unknown) {
  let input = value;
  if (typeof input === "string" && input.length <= 600_000) {
    try {
      input = JSON.parse(input);
    } catch {
      input = undefined;
    }
  }
  const compact: Record<string, string | number> = {};
  if (!Predicate.isObject(input) || Array.isArray(input)) return compact;
  if (typeof input.html === "string") compact.htmlBytes = encoder.encode(input.html).byteLength;
  else if (Number.isSafeInteger(input.htmlBytes) && (input.htmlBytes as number) >= 0) {
    compact.htmlBytes = input.htmlBytes as number;
  }
  if (tool === "html_render") {
    const title = boundedText(input.title, 800)?.trim().slice(0, 200);
    if (title !== undefined) compact.title = title;
    if (typeof input.height === "number" && Number.isFinite(input.height)) {
      compact.height = input.height;
    }
  } else {
    if (typeof input.width === "number" && Number.isFinite(input.width))
      compact.width = input.width;
    if (input.appearance === "light" || input.appearance === "dark") {
      compact.appearance = input.appearance;
    }
  }
  return compact;
}

function compactPreview(data: Readonly<Record<string, unknown>> | undefined) {
  const output: Record<string, unknown> = {};
  if (data === undefined) return output;
  for (const key of ["width", "contentHeight", "capturedHeight"] as const) {
    if (typeof data[key] === "number" && Number.isFinite(data[key]) && data[key] > 0) {
      output[key] = data[key];
    }
  }
  if (Predicate.isObject(data.screenshot)) {
    const { width, height, mimeType } = data.screenshot;
    if (
      mimeType === "image/png" &&
      typeof width === "number" &&
      typeof height === "number" &&
      Number.isFinite(width) &&
      width > 0 &&
      Number.isFinite(height) &&
      height > 0
    ) {
      output.screenshot = { mimeType, width, height };
    }
  }
  // Keep all projected metadata within one budget; never serialize raw provider output.
  let remaining = MAX_METADATA_BYTES - encoder.encode(JSON.stringify(output)).byteLength - 100;
  if (Array.isArray(data.consoleMessages)) {
    const messages: Array<{ level: string; text: string }> = [];
    for (const entry of data.consoleMessages.slice(0, 21)) {
      if (
        !Predicate.isObject(entry) ||
        typeof entry.level !== "string" ||
        !["log", "info", "warning", "error"].includes(entry.level)
      )
        continue;
      const text = boundedText(entry.text, Math.min(2000, Math.max(0, remaining)))?.slice(0, 500);
      if (text === undefined) continue;
      const message = { level: entry.level, text };
      const bytes = encoder.encode(JSON.stringify(message)).byteLength + 1;
      if (bytes > remaining) break;
      messages.push(message);
      remaining -= bytes;
    }
    output.consoleMessages = messages;
  }
  if (Array.isArray(data.missingImages)) {
    const images: string[] = [];
    for (const entry of data.missingImages.slice(0, 24)) {
      const path = boundedText(entry, Math.min(1024, Math.max(0, remaining)));
      if (path === undefined) continue;
      const bytes = encoder.encode(JSON.stringify(path)).byteLength + 1;
      if (bytes > remaining) break;
      images.push(path);
      remaining -= bytes;
    }
    output.missingImages = images;
  }
  return output;
}

export interface HtmlToolProjection<TToolName = string | null | undefined> {
  readonly toolName: TToolName;
  readonly input: unknown;
  readonly output?: unknown;
}

/** Normalizes only own HTML calls at adapter boundaries, keeping HTML and PNG bytes off the wire. */
export function compactHtmlToolProjection<TToolName extends string | null | undefined>(
  projection: HtmlToolProjection<TToolName>,
): HtmlToolProjection<TToolName | string> {
  const tool = resolvePathwayMcpToolId(projection.toolName);
  if (tool !== "html_render" && tool !== "html_preview") return projection;
  const normalized = { toolName: `pathway.${tool}`, input: compactInput(tool, projection.input) };
  if (projection.output === undefined) return normalized;
  const { data, isError } = readToolOutput(projection.output);
  const message = boundedText(data?.message) ?? boundedText(data?.error) ?? "";
  if (isError)
    return {
      ...normalized,
      output: { isError: true, message: boundedJsonText(message, MAX_METADATA_BYTES - 100) },
    };
  if (tool === "html_preview") return { ...normalized, output: compactPreview(data) };
  const htmlRender = readHtmlRenderReference(data?.htmlRender);
  if (htmlRender === undefined) {
    return {
      ...normalized,
      output: {
        isError: true,
        message: boundedJsonText(
          message || "Invalid HTML render result.",
          MAX_METADATA_BYTES - 100,
        ),
      },
    };
  }
  const referenceBytes = encoder.encode(JSON.stringify({ htmlRender, message: "" })).byteLength;
  return {
    ...normalized,
    output: { htmlRender, message: boundedJsonText(message, MAX_METADATA_BYTES - referenceBytes) },
  };
}
