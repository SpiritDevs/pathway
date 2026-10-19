// Adapted from Sotto's TranscriptCleaner, PersonalDictionary and TextCorrectionPolicy.
// Copyright (c) 2026 Davis. MIT. See native/dictation/NOTICE.md.
import type { DictationDictionaryList } from "@spiritdevs/contracts/dictation";

const escapePattern = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordBoundary = "\\p{L}\\p{N}\\p{M}\\p{Pc}\\u200C\\u200D";
const phrasePattern = (phrase: string) =>
  new RegExp(`(?<![${wordBoundary}])${escapePattern(phrase)}(?![${wordBoundary}])`, "giu");

export function cleanRecognizedText(raw: string): string {
  const text = raw.trim();
  if (/^(?:\[(?:BLANK_AUDIO|NO_SPEECH|SILENCE|MUSIC)\]|\(silence\))$/i.test(text)) return "";
  return text
    .replace(/<\|[^|]*\|>/g, "")
    .replace(/[\t ]+/g, " ")
    .trim();
}

/** Matches the original input once, so corrections cannot cascade into other aliases. */
export function applyDictationDictionary(
  text: string,
  lists: readonly DictationDictionaryList[],
): string {
  const replacements = new Map<string, string>();
  for (const list of lists)
    for (const term of list.terms) {
      for (const phrase of [term.spelling, ...term.aliases])
        replacements.set(phrase.trim(), term.spelling.trim());
    }
  if (replacements.size === 0) return text;
  const phrases = [...replacements.keys()].sort((a, b) => b.length - a.length);
  const normalized = new Map(
    [...replacements].map(([phrase, spelling]) => [phrase.toLocaleLowerCase("und"), spelling]),
  );
  const pattern = new RegExp(
    `(?<![${wordBoundary}])(?:${phrases.map(escapePattern).join("|")})(?![${wordBoundary}])`,
    "giu",
  );
  return text.replace(
    pattern,
    (matched) => normalized.get(matched.toLocaleLowerCase("und")) ?? matched,
  );
}

export function dictationModelHints(lists: readonly DictationDictionaryList[]): readonly string[] {
  const hints: string[] = [];
  let bytes = 0;
  for (const list of lists)
    for (const term of list.terms) {
      const size = new TextEncoder().encode(term.spelling).length;
      if (hints.length < 80 && size <= 256 && bytes + size <= 4096) {
        hints.push(term.spelling);
        bytes += size;
      }
    }
  return hints;
}

/** Rejects obvious corruption while allowing spoken self-corrections to shorten a transcript. */
export function acceptableDictationCleanup(
  original: string,
  candidate: string,
  hints: readonly string[],
): boolean {
  const output = candidate.trim();
  if (
    !output ||
    output.startsWith("```") ||
    (/^[{[]/.test(output) && !/^[{[]/.test(original.trim())) ||
    output.length > Math.max(original.length * 2, 100) ||
    /<\||<\/?think>/i.test(output)
  )
    return false;
  if (
    /^(?:here is|here's|corrected (?:text|transcript):|sure,|certainly,)/i.test(output) &&
    !/^(?:here is|here's|corrected (?:text|transcript):|sure,|certainly,)/i.test(original)
  )
    return false;
  const numbers = (text: string): string[] => text.match(/[\p{N}]+(?:[.,:/-][\p{N}]+)*/gu) ?? [];
  const beforeNumbers = numbers(original);
  const afterNumbers = numbers(output);
  const corrections = [
    ...original.matchAll(
      /\b(?:actually|sorry|i meant?|no wait|rather|en fait|pardon|mejor dicho|perdón|digo|eigentlich)\b/giu,
    ),
  ];
  const finalCorrection = corrections.at(-1);
  const selfCorrection = finalCorrection !== undefined;
  if (!selfCorrection && beforeNumbers.join("|") !== afterNumbers.join("|")) return false;
  // An explicit correction can retract a number, but must not invent a different one.
  if (afterNumbers.some((number) => !beforeNumbers.includes(number))) return false;
  if (hints.some((term) => phrasePattern(term).test(original) && !phrasePattern(term).test(output)))
    return false;
  const words = (text: string): string[] =>
    text
      .toLocaleLowerCase()
      .replaceAll("’", "'")
      .match(/[\p{L}\p{N}]+(?:'[\p{L}]+)?/gu) ?? [];
  const beforeWords = words(original);
  const afterWords = words(output);
  if (finalCorrection) {
    const removable = new Set([
      "um",
      "uh",
      "er",
      "eh",
      "euh",
      "the",
      "a",
      "an",
      "el",
      "la",
      "le",
      "les",
      "un",
      "une",
    ]);
    const correctedWords = words(
      original.slice(finalCorrection.index + finalCorrection[0].length),
    ).filter((word) => !removable.has(word));
    if (correctedWords.some((word) => !afterWords.includes(word))) return false;
  }
  const negations = (values: string[]) =>
    [
      ...new Set(
        values.filter(
          (word) =>
            [
              "no",
              "not",
              "never",
              "without",
              "nicht",
              "kein",
              "jamais",
              "non",
              "не",
              "нет",
            ].includes(word) || word.endsWith("n't"),
        ),
      ),
    ]
      .sort()
      .join("|");
  if (!selfCorrection && negations(beforeWords) !== negations(afterWords)) return false;
  if (beforeWords.length > 5 && afterWords.length > beforeWords.length * 1.4) return false;
  const shared = afterWords.filter((word) => beforeWords.includes(word)).length;
  if (afterWords.length === 0) return beforeWords.length === 0 && output === original.trim();
  if (beforeWords.length >= 10 && afterWords.length < beforeWords.length * 0.4) return false;
  return shared / afterWords.length >= 0.65;
}
