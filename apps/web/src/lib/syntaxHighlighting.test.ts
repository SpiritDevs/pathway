import type { DiffsHighlighter } from "@pierre/diffs";
import { expect, it, vi } from "vite-plus/test";

const { getSharedHighlighter } = vi.hoisted(() => ({
  getSharedHighlighter: vi.fn(),
}));

vi.mock("@pierre/diffs", () => ({
  getSharedHighlighter,
}));

import { getSyntaxHighlighterPromise, highlightCode } from "./syntaxHighlighting";

it("caches the recovered text highlighter for unsupported languages", async () => {
  const textHighlighter = {} as DiffsHighlighter;
  getSharedHighlighter.mockImplementation(({ langs }: { langs: string[] }) =>
    langs[0] === "text"
      ? Promise.resolve(textHighlighter)
      : Promise.reject(new Error("unsupported language")),
  );

  const first = getSyntaxHighlighterPromise("unsupported-test-language");
  await expect(first).resolves.toBe(textHighlighter);
  const second = getSyntaxHighlighterPromise("unsupported-test-language");

  expect(second).toBe(first);
  expect(getSharedHighlighter).toHaveBeenCalledTimes(2);
});

it("falls back to text when tokenization rejects a language", async () => {
  const codeToHtml = vi.fn<(code: string, options: { lang: string; theme: string }) => string>();
  codeToHtml.mockImplementation((_code, options) => {
    if (options.lang !== "text") throw new Error("unsupported language");
    return "<pre>plain</pre>";
  });
  getSharedHighlighter.mockResolvedValue({ codeToHtml });
  await expect(highlightCode("real code", "fallback-code-test", "pierre-dark")).resolves.toBe(
    "<pre>plain</pre>",
  );
  expect(codeToHtml).toHaveBeenLastCalledWith("real code", { lang: "text", theme: "pierre-dark" });
});
