import type { DetectedEmailCode } from "@spiritdevs/contracts";

const KEYWORD = String.raw`(?:code|verification|otp|one[\s-]?time|passcode|confirm(?:ation)?)`;
const KEYWORD_EXPRESSION = new RegExp(String.raw`\b${KEYWORD}\b`, "giu");
const CODE_EXPRESSION = /(?<![A-Za-z0-9])[A-Za-z0-9]{4,8}(?![A-Za-z0-9])/giu;

const isCode = (value: string): value is DetectedEmailCode =>
  value.length >= 4 && value.length <= 8 && /^[A-Za-z0-9]+$/.test(value) && /\d/.test(value);

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
    if (!isCode(code)) continue;
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
 * Finds a short alphanumeric login code near an email-verification keyword. A project override
 * wins when it produces a valid 4-8 character match; invalid patterns safely fall back.
 */
export function detectTwoFactorCode(input: {
  readonly subject: string | null;
  readonly textBody: string | null;
  readonly htmlBody: string | null;
  readonly projectRegex?: string | null;
}): DetectedEmailCode | null {
  const content = [input.subject, input.textBody, input.htmlBody].filter(Boolean).join("\n");
  if (input.projectRegex !== undefined && input.projectRegex !== null) {
    const overridden = overrideMatch(content, input.projectRegex);
    if (overridden !== null) return overridden;
  }
  return heuristicMatch(content);
}
