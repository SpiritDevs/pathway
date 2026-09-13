// Optional native regression: compare optimized sampling with a preserved baseline worker.
// Uses installed models and synthetic text only; never downloads weights.
import * as NodeAssert from "node:assert/strict";
import { DictationInference } from "../../../../apps/desktop/src/dictation/DictationInference.ts";
import { assertCleanupQuality, cleanupQualityCases } from "./cleanup-quality.mjs";

const args = process.argv.slice(2);
const required = (name) => {
  const value = args[args.indexOf(name) + 1];
  NodeAssert.ok(args.includes(name) && value && !value.startsWith("--"), `${name} is required`);
  return value;
};
const modelDirectory = required("--model-directory");
const baselineDirectory = required("--baseline-directory");
const engineDirectory = required("--engine-directory");
const cases = [
  ...cleanupQualityCases,
  {
    id: "json-escaping-and-unicode",
    language: "en",
    text: 'Keep the label "Élodie" and the folder C:\\Reports.\nDo not change the 27 invoices.',
    terms: ["Élodie"],
    expected: [/Élodie/, /27/, /not change/i],
    absent: [],
  },
  {
    id: "longer-dictation",
    language: "en",
    text:
      "Please update the settings page so the microphone selector is easier to find. " +
      "Keep the existing keyboard shortcut and preserve the selected language. " +
      "The recording should stop when I release the key, and the text should appear in the focused field. " +
      "Do not submit the message automatically. I want to review it before sending it to the team.",
    terms: [],
    expected: [/microphone/, /language/, /review/i],
    absent: [],
  },
];
const requests = [cases, cases.toReversed()].flatMap((round) =>
  round.flatMap((item) => ["auto", item.language].map((language) => ({ item, language }))),
);
async function run(directory) {
  const inference = new DictationInference({
    engineDirectory: directory,
    modelDirectory,
    device: "gpu",
    inferenceTimeoutMs: 65000,
  });
  const results = [];
  try {
    // Exclude model preparation from per-request timing, as in a warm desktop session.
    await inference.prepare({
      modelId: "whisper-base",
      cleanup: true,
      signal: new AbortController().signal,
    });
    for (const { item, language } of requests) {
      const started = performance.now();
      const text = await inference.cleanup({ text: item.text, terms: item.terms, language });
      assertCleanupQuality(item, text);
      results.push({ text, ms: performance.now() - started });
    }
    return results;
  } finally {
    await inference.dispose();
  }
}
const baseline = await run(baselineDirectory);
console.log(`Baseline: ${baseline.length} quality checks passed.`);
const updated = await run(engineDirectory);
for (let i = 0; i < requests.length; i++) {
  NodeAssert.equal(
    updated[i].text,
    baseline[i].text,
    `Output changed: ${requests[i].item.id} (${requests[i].language})`,
  );
}
const median = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return Math.round(sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2);
};
for (const language of ["auto", "explicit"]) {
  const timings = (results) =>
    results
      .filter((_, i) => (requests[i].language === "auto") === (language === "auto"))
      .map(({ ms }) => ms);
  console.log(
    JSON.stringify({
      language,
      baselineMedianMs: median(timings(baseline)),
      updatedMedianMs: median(timings(updated)),
    }),
  );
}
console.log(`PASS: ${updated.length} quality checks and byte-for-byte baseline comparisons.`);
