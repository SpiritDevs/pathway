import type { HighlightRequest, HighlightResponse } from "./markdownHighlightQueue";
import { highlightCode } from "./syntaxHighlighting";

self.addEventListener("message", async ({ data }: MessageEvent<HighlightRequest>) => {
  let html: string | null = null;
  try {
    html = await highlightCode(data.code, data.language, data.themeName);
  } catch (cause) {
    console.warn(
      "[chat-markdown] worker highlight failed",
      cause instanceof Error ? cause.message : String(cause),
    );
    // A failed highlighter leaves the already rendered plain code in place.
  }
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Worker, not a window.
  self.postMessage({ id: data.id, html } satisfies HighlightResponse);
});
