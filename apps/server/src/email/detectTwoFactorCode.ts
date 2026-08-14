import type { DetectedEmailCode } from "@t3tools/contracts";

import { visibleHtmlText } from "./DeliverabilityAnalyzer.ts";

const KEYWORD = String.raw`(?:code|verification|otp|one[\s-]?time|passcode|confirm(?:ation)?)`;
const KEYWORD_EXPRESSION = new RegExp(String.raw`\b${KEYWORD}\b`, "giu");
const CODE = String.raw`[A-Za-z0-9](?:[A-Za-z0-9-]{2,30}[A-Za-z0-9])`;
const CODE_EXPRESSION = new RegExp(String.raw`(?<![A-Za-z0-9-])${CODE}(?![A-Za-z0-9-])`, "giu");
const EXPLICIT_CODE_EXPRESSIONS = [
  new RegExp(String.raw`\b${KEYWORD}\b\s+(?:is|equals)\s+(${CODE})(?![A-Za-z0-9-])`, "giu"),
  new RegExp(String.raw`\b${KEYWORD}\b\s*(?::|=|[–—])\s*(${CODE})(?![A-Za-z0-9-])`, "giu"),
  new RegExp(String.raw`\b(?:use|enter|type|paste)\s+(${CODE})\s+(?:to\s+)?${KEYWORD}\b`, "giu"),
  new RegExp(String.raw`(?<![A-Za-z0-9-])(${CODE})\s+is\s+(?:your|the)\s+${KEYWORD}\b`, "giu"),
];

const isCode = (value: string): value is DetectedEmailCode =>
  value.length >= 4 && value.length <= 32 && /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/.test(value);

const isDistinctiveCode = (value: DetectedEmailCode): boolean =>
  /\d|-/.test(value) || (/[A-Z]/.test(value) && value === value.toUpperCase());

function overrideMatch(content: string, pattern: string): DetectedEmailCode | null {
  try {
    const match = new RegExp(pattern, "iu").exec(content);
    if (match === null) return null;
    const candidate = match[1] ?? match[0];
    return isCode(candidate) ? candidate : null;
  } catch {
    // A bad project override must not disable the zero-config detector.
    return null;
  }
}

function explicitMatch(content: string): DetectedEmailCode | null {
  const matches = EXPLICIT_CODE_EXPRESSIONS.flatMap((expression) =>
    [...content.matchAll(expression)].flatMap((match) =>
      match[1] === undefined ? [] : [{ candidate: match[1], index: match.index }],
    ),
  ).sort((left, right) => left.index - right.index);
  for (const match of matches) {
    if (isCode(match.candidate)) return match.candidate;
  }
  return null;
}

function heuristicMatch(content: string): DetectedEmailCode | null {
  const keywords = [...content.matchAll(KEYWORD_EXPRESSION)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const candidates: Array<{
    readonly code: DetectedEmailCode;
    readonly index: number;
    readonly distance: number;
    readonly followsKeyword: boolean;
  }> = [];
  for (const match of content.matchAll(CODE_EXPRESSION)) {
    const code = match[0];
    if (!isCode(code) || !isDistinctiveCode(code)) continue;
    const codeEnd = match.index + code.length;
    for (const keyword of keywords) {
      const followsKeyword = match.index >= keyword.end;
      const distance = followsKeyword ? match.index - keyword.end : keyword.start - codeEnd;
      if (distance >= 0 && distance <= 64) {
        candidates.push({ code, index: match.index, distance, followsKeyword });
      }
    }
  }
  candidates.sort(
    (left, right) =>
      Number(right.followsKeyword) - Number(left.followsKeyword) ||
      left.distance - right.distance ||
      left.index - right.index,
  );
  return candidates[0]?.code ?? null;
}

/**
 * Finds a 4-32 character login code near an email-verification keyword. A project override wins
 * when it produces a valid numeric, alphabetic, alphanumeric, or internally dashed match; invalid
 * patterns safely fall back.
 */
export function detectTwoFactorCode(input: {
  readonly subject: string | null;
  readonly textBody: string | null;
  readonly htmlBody: string | null;
  readonly projectRegex?: string | null;
}): DetectedEmailCode | null {
  const sources = [
    input.subject,
    input.textBody,
    input.htmlBody === null ? null : visibleHtmlText(input.htmlBody),
  ].filter((source): source is string => source !== null && source.trim().length > 0);
  const content = sources.join("\n");
  if (input.projectRegex !== undefined && input.projectRegex !== null) {
    const overridden = overrideMatch(content, input.projectRegex);
    if (overridden !== null) return overridden;
  }
  for (const source of sources) {
    const explicit = explicitMatch(source);
    if (explicit !== null) return explicit;
  }
  for (const source of sources) {
    const heuristic = heuristicMatch(source);
    if (heuristic !== null) return heuristic;
  }
  return heuristicMatch(content);
}
