// bun apps/web/scripts/benchmark-markdown-highlighting.ts snapshot.sqlite [1850,3128]
// Read-only snapshot; report timings and hashes, never message or code contents.
import { Database } from "bun:sqlite";
import { MarkdownHighlightQueue, markdownHighlightKey } from "../src/lib/markdownHighlightQueue";
import { getSyntaxHighlighterPromise } from "../src/lib/syntaxHighlighting";
import { fnv1a32 } from "../src/lib/diffRendering";

const snapshot = process.argv[2];
if (!snapshot) throw new Error("Pass a read-only snapshot path");
const lengths = process.argv[3]?.split(",").map(Number);
const blocks = new Map<number, { code: string; language: string }>();
const db = new Database(snapshot, { readonly: true });
try {
  for (const row of db
    .query<{ payload_json: string }, []>(
      "SELECT payload_json FROM orchestration_v2_projection_messages",
    )
    .iterate()) {
    const { text } = JSON.parse(row.payload_json) as { text: string };
    for (const match of text.matchAll(/```(tsx|ts|typescript)[^\n]*\n([\s\S]*?)```/g)) {
      const code = match[2]!;
      if ((!lengths || lengths.includes(code.length)) && !blocks.has(code.length)) {
        blocks.set(code.length, { code, language: match[1]! });
        if (!lengths && blocks.size > 2) blocks.delete(Math.min(...blocks.keys()));
      }
    }
  }
} finally {
  db.close();
}
if (blocks.size === 0 || (lengths && blocks.size !== lengths.length)) {
  throw new Error("Requested code blocks are missing from this snapshot");
}

let worker: Worker | undefined;
const queue = new MarkdownHighlightQueue(() => {
  worker = new Worker(new URL("../src/lib/markdownHighlighting.worker.ts", import.meta.url).href);
  return worker;
});
try {
  for (const [characters, { code, language }] of blocks) {
    const highlighter = await getSyntaxHighlighterPromise(language);
    const beforeStart = performance.now();
    const beforeHtml = highlighter.codeToHtml(code, { lang: language, theme: "pierre-dark" });
    const beforeBlockingMs = performance.now() - beforeStart;
    const lines = code.split(/\r\n|\n|\r/).length;
    if (beforeHtml.match(/<span class="line">/g)?.length !== lines) {
      throw new Error("Plain code and Shiki reserve different line counts");
    }
    const warmSamples = Array.from({ length: 3 }, () => {
      const start = performance.now();
      highlighter.codeToHtml(code, { lang: language, theme: "pierre-dark" });
      return performance.now() - start;
    }).sort((a, b) => a - b);
    // Include the render-time cache lookup, hashing and the effect's dispatch.
    const afterStart = performance.now();
    const key = markdownHighlightKey(code, language, "pierre-dark");
    if (queue.get(key) !== null) throw new Error("Expected an uncached block");
    const request = queue.request(code, language, "pierre-dark");
    const afterBlockingMs = performance.now() - afterStart;
    const afterHtml = await request.result;
    if (afterHtml === null)
      throw new Error("Worker highlighting failed; plain fallback remains available");
    // A cold first render can hit Shiki's per-line time limit, so compare against a warm render.
    const warmHtml = highlighter.codeToHtml(code, { lang: language, theme: "pierre-dark" });
    if (afterHtml !== warmHtml)
      throw new Error("Worker HTML differs from synchronous highlighting");
    console.log(
      JSON.stringify({
        characters,
        language,
        lines,
        hash: fnv1a32(code).toString(36),
        beforeBlockingMs,
        warmMedianBlockingMs: warmSamples[1],
        afterBlockingMs,
        highlightReadyMs: performance.now() - afterStart,
      }),
    );
  }
} finally {
  worker?.terminate();
}
