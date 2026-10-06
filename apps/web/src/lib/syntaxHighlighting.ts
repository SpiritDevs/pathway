import type { DiffsHighlighter, SupportedLanguages } from "@pierre/diffs";

import { resolveDiffThemeName, type DiffThemeName } from "./diffRendering";

const highlighterPromiseCache = new Map<string, Promise<DiffsHighlighter>>();

export function getSyntaxHighlighterPromise(language: string): Promise<DiffsHighlighter> {
  const cached = highlighterPromiseCache.get(language);
  if (cached) return cached;

  // Shiki and its regex engine load on first highlight, not with whichever
  // eager surface (search, attachments) happens to import this module.
  const promise = import("@pierre/diffs")
    .then(({ getSharedHighlighter }) =>
      getSharedHighlighter({
        themes: [resolveDiffThemeName("dark"), resolveDiffThemeName("light")],
        langs: [language as SupportedLanguages],
        preferredHighlighter: "shiki-js",
      }),
    )
    .catch((error) => {
      if (language === "text") {
        highlighterPromiseCache.delete(language);
        // "text" itself failed — Shiki cannot initialize at all, surface the error
        throw error;
      }
      // Language not supported by Shiki — fall back to "text"
      return getSyntaxHighlighterPromise("text");
    });
  highlighterPromiseCache.set(language, promise);
  return promise;
}

export async function highlightCode(
  code: string,
  language: string,
  themeName: DiffThemeName,
  options?: { readonly tokenizeTimeLimit?: number },
) {
  const highlighter = await getSyntaxHighlighterPromise(language);
  try {
    return highlighter.codeToHtml(code, { lang: language, theme: themeName, ...options });
  } catch {
    return highlighter.codeToHtml(code, { lang: "text", theme: themeName, ...options });
  }
}
