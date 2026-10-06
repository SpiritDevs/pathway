import type { HighlightRequest, HighlightResponse } from "./markdownHighlightQueue";
import { highlightCode } from "./syntaxHighlighting";

const WORKER_TOKENIZE_TIME_LIMIT_MS = 5_000;

self.addEventListener("message", async ({ data }: MessageEvent<HighlightRequest>) => {
  let html: string | null = null;
  try {
    // Shiki gives up on a line after 500 ms and leaves the rest plain, which a cold engine can hit.
    // Off the main thread a slow line only delays colour, and the result is cached for the session.
    html = await highlightCode(data.code, data.language, data.themeName, {
      tokenizeTimeLimit: WORKER_TOKENIZE_TIME_LIMIT_MS,
    });
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
