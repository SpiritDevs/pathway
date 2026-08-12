/**
 * Deterministic structural checks for captured mail.
 *
 * This module deliberately has no DNS, HTTP, clock, or configuration dependency. Authentication
 * results are inspected only when a sender or upstream test fixture included the corresponding
 * headers; DKIM is parsed structurally and is never cryptographically verified.
 *
 * @module email/DeliverabilityAnalyzer
 */
import type {
  EmailDeliverabilityCheck,
  EmailDeliverabilityResult,
  EmailHeader,
  EmailHtmlCompatibilityWarning,
  EmailParsedHeaders,
} from "@t3tools/contracts";

export const EMAIL_DELIVERABILITY_ENGINE_VERSION = 1;
export const EMAIL_SUBJECT_WARNING_LENGTH = 78;
export const EMAIL_IMAGE_TO_TEXT_WARNING_RATIO = 0.01;

export interface DeliverabilityEmailInput {
  readonly parsedHeaders: EmailParsedHeaders;
  readonly textBody: string | null;
  readonly htmlBody: string | null;
}

interface HtmlCompatibilityRule {
  readonly ruleId: string;
  readonly feature: string;
  readonly clients: ReadonlyArray<string>;
  readonly detail: string;
  readonly pattern: RegExp;
}

/**
 * A deliberately small, reviewable table inspired by caniemail's feature matrix. It warns about
 * constructs with well-known partial support; it is not a browser engine or a live compatibility
 * database.
 */
const HTML_COMPATIBILITY_RULES: ReadonlyArray<HtmlCompatibilityRule> = [
  {
    ruleId: "css-display-flex",
    feature: "CSS flexbox",
    clients: ["Outlook for Windows"],
    detail:
      "Flexbox has partial support in desktop Outlook; use table layout for critical content.",
    pattern: /display\s*:\s*(?:inline-)?flex\b/i,
  },
  {
    ruleId: "css-display-grid",
    feature: "CSS grid",
    clients: ["Gmail", "Outlook for Windows", "Yahoo Mail"],
    detail: "CSS grid is not consistently supported; use table layout for critical content.",
    pattern: /display\s*:\s*(?:inline-)?grid\b/i,
  },
  {
    ruleId: "css-positioning",
    feature: "CSS positioning",
    clients: ["Gmail", "Outlook for Windows"],
    detail: "Absolute and fixed positioning are unreliable in email clients.",
    pattern: /position\s*:\s*(?:absolute|fixed)\b/i,
  },
  {
    ruleId: "css-background-image",
    feature: "CSS background images",
    clients: ["Outlook for Windows"],
    detail: "CSS background images need an Outlook-specific fallback.",
    pattern: /background(?:-image)?\s*:[^;{}]*url\s*\(/i,
  },
  {
    ruleId: "html-form",
    feature: "HTML forms",
    clients: ["Gmail", "Outlook", "Yahoo Mail"],
    detail: "Interactive forms are removed or disabled by many email clients.",
    pattern: /<form\b/i,
  },
  {
    ruleId: "html-video",
    feature: "HTML video",
    clients: ["Gmail", "Outlook for Windows"],
    detail: "HTML video needs a linked poster-image fallback.",
    pattern: /<video\b/i,
  },
  {
    ruleId: "html-svg",
    feature: "Inline SVG",
    clients: ["Gmail", "Outlook for Windows", "Yahoo Mail"],
    detail: "Inline SVG is removed or only partially rendered by common email clients.",
    pattern: /<svg\b/i,
  },
];

const headerValues = (headers: ReadonlyArray<EmailHeader>, name: string): ReadonlyArray<string> => {
  const normalizedName = name.toLowerCase();
  return headers
    .filter((header) => header.name.toLowerCase() === normalizedName)
    .map((header) => header.value.trim())
    .filter((value) => value.length > 0);
};

const makeCheck = (
  id: EmailDeliverabilityCheck["id"],
  status: EmailDeliverabilityCheck["status"],
  summary: string,
  detail: string,
): EmailDeliverabilityCheck => ({ id, status, summary, detail });

const AUTH_RESULT_PATTERN: Readonly<Record<"spf" | "dmarc", RegExp>> = {
  spf: /(?:^|[;\s])spf\s*=\s*([a-z][a-z0-9_-]*)/i,
  dmarc: /(?:^|[;\s])dmarc\s*=\s*([a-z][a-z0-9_-]*)/i,
};

const SPF_RESULTS = new Set([
  "pass",
  "fail",
  "softfail",
  "neutral",
  "none",
  "temperror",
  "permerror",
]);
const DMARC_RESULTS = new Set(["pass", "fail", "bestguesspass", "none", "temperror", "permerror"]);

const findAuthenticationResult = (
  headers: ReadonlyArray<EmailHeader>,
  mechanism: "spf" | "dmarc",
): string | null => {
  for (const value of headerValues(headers, "Authentication-Results")) {
    const result = AUTH_RESULT_PATTERN[mechanism].exec(value)?.[1];
    if (result !== undefined) return result.toLowerCase();
  }
  return null;
};

const analyzeSpf = (headers: ReadonlyArray<EmailHeader>): EmailDeliverabilityCheck => {
  const receivedSpf = headerValues(headers, "Received-SPF");
  const result =
    receivedSpf.length > 0
      ? (/^([a-z][a-z0-9_-]*)\b/i.exec(receivedSpf[0] ?? "")?.[1]?.toLowerCase() ?? null)
      : findAuthenticationResult(headers, "spf");

  if (receivedSpf.length === 0 && result === null) {
    return makeCheck(
      "spf",
      "warning",
      "SPF result header is missing",
      "No Received-SPF header or spf result in Authentication-Results was captured.",
    );
  }
  if (result === null || !SPF_RESULTS.has(result)) {
    return makeCheck(
      "spf",
      "fail",
      "SPF result header is malformed",
      "The captured SPF result does not use a recognized result token.",
    );
  }
  return makeCheck(
    "spf",
    "pass",
    "SPF result header is structurally valid",
    `The captured SPF result is ${result}; no DNS verification was performed.`,
  );
};

const parseTagList = (value: string): ReadonlyMap<string, string> | null => {
  const tags = new Map<string, string>();
  for (const rawPart of value.split(";")) {
    const part = rawPart.trim();
    if (part.length === 0) continue;
    const separator = part.indexOf("=");
    if (separator <= 0) return null;
    const name = part.slice(0, separator).trim().toLowerCase();
    const tagValue = part.slice(separator + 1).trim();
    if (!/^[a-z][a-z0-9_]*$/.test(name) || tags.has(name)) return null;
    tags.set(name, tagValue);
  }
  return tags;
};

const BASE64_VALUE = /^[a-z0-9+/]+={0,2}$/i;
const DKIM_REQUIRED_TAGS = ["v", "a", "d", "s", "h", "bh", "b"] as const;

const isStructurallyValidDkim = (value: string): boolean => {
  const tags = parseTagList(value);
  if (tags === null || DKIM_REQUIRED_TAGS.some((tag) => !tags.has(tag))) return false;
  const bodyHash = (tags.get("bh") ?? "").replace(/\s+/g, "");
  const signature = (tags.get("b") ?? "").replace(/\s+/g, "");
  return (
    tags.get("v") === "1" &&
    /^[a-z0-9]+-[a-z0-9]+$/i.test(tags.get("a") ?? "") &&
    /^[^\s;@.]+(?:\.[^\s;@.]+)*$/.test(tags.get("d") ?? "") &&
    /^[^\s;]+$/.test(tags.get("s") ?? "") &&
    /^(?:[a-z0-9-]+:)*[a-z0-9-]+$/i.test(tags.get("h") ?? "") &&
    BASE64_VALUE.test(bodyHash) &&
    BASE64_VALUE.test(signature)
  );
};

const analyzeDkim = (headers: ReadonlyArray<EmailHeader>): EmailDeliverabilityCheck => {
  const signatures = headerValues(headers, "DKIM-Signature");
  if (signatures.length === 0) {
    return makeCheck(
      "dkim",
      "warning",
      "DKIM signature header is missing",
      "No DKIM-Signature header was captured.",
    );
  }
  if (signatures.some((value) => !isStructurallyValidDkim(value))) {
    return makeCheck(
      "dkim",
      "fail",
      "DKIM signature is malformed",
      "At least one DKIM-Signature is missing a required tag or contains invalid tag syntax.",
    );
  }
  return makeCheck(
    "dkim",
    "pass",
    "DKIM signature is structurally valid",
    "Required tags and value shapes are present; the signature was not cryptographically verified.",
  );
};

const analyzeDmarc = (headers: ReadonlyArray<EmailHeader>): EmailDeliverabilityCheck => {
  const result = findAuthenticationResult(headers, "dmarc");
  if (result === null) {
    return makeCheck(
      "dmarc",
      "warning",
      "DMARC result header is missing",
      "No dmarc result was found in Authentication-Results.",
    );
  }
  if (!DMARC_RESULTS.has(result)) {
    return makeCheck(
      "dmarc",
      "fail",
      "DMARC result header is malformed",
      "The captured DMARC result does not use a recognized result token.",
    );
  }
  return makeCheck(
    "dmarc",
    "pass",
    "DMARC result header is structurally valid",
    `The captured DMARC result is ${result}; no DNS policy lookup was performed.`,
  );
};

const imageTags = (html: string): ReadonlyArray<string> => html.match(/<img\b[^>]*>/gi) ?? [];

const numericDimension = (tag: string, dimension: "width" | "height"): number | null => {
  const attribute = new RegExp(`\\b${dimension}\\s*=\\s*(?:["']\\s*)?(\\d+(?:\\.\\d+)?)`, "i").exec(
    tag,
  )?.[1];
  if (attribute !== undefined) return Number(attribute);
  const style = /\bstyle\s*=\s*["']([^"']*)["']/i.exec(tag)?.[1] ?? "";
  const styleValue = new RegExp(
    `(?:^|;)\\s*${dimension}\\s*:\\s*(\\d+(?:\\.\\d+)?)px\\b`,
    "i",
  ).exec(style)?.[1];
  return styleValue === undefined ? null : Number(styleValue);
};

const isTrackingPixel = (tag: string): boolean => {
  const width = numericDimension(tag, "width");
  const height = numericDimension(tag, "height");
  return width !== null && height !== null && width <= 1 && height <= 1;
};

const decodeNumericEntity = (digits: string, radix: number, original: string): string => {
  const codePoint = Number.parseInt(digits, radix);
  return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
    ? String.fromCodePoint(codePoint)
    : original;
};

const decodeBasicHtmlEntities = (value: string): string =>
  value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (entity: string, digits: string) =>
      decodeNumericEntity(digits, 10, entity),
    )
    .replace(/&#x([\da-f]+);/gi, (entity: string, digits: string) =>
      decodeNumericEntity(digits, 16, entity),
    );

const visibleHtmlText = (html: string): string =>
  decodeBasicHtmlEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(
        /<(?:head|style|script|template)\b[^>]*>[\s\S]*?<\/(?:head|style|script|template)>/gi,
        " ",
      )
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();

const compatibilityWarnings = (
  html: string | null,
): ReadonlyArray<EmailHtmlCompatibilityWarning> => {
  if (html === null) return [];
  return HTML_COMPATIBILITY_RULES.filter((rule) => rule.pattern.test(html)).map((rule) => ({
    ruleId: rule.ruleId,
    feature: rule.feature,
    clients: [...rule.clients],
    detail: rule.detail,
  }));
};

const roundedRatio = (imageCount: number, visibleTextCharacters: number): number => {
  if (imageCount === 0) return 0;
  return Number((imageCount / Math.max(visibleTextCharacters, 1)).toFixed(4));
};

export const analyzeEmailDeliverability = (
  input: DeliverabilityEmailInput,
): EmailDeliverabilityResult => {
  const { parsedHeaders, textBody, htmlBody } = input;
  const headers = parsedHeaders.headers;
  const images = htmlBody === null ? [] : imageTags(htmlBody);
  const visibleText =
    htmlBody === null ? (textBody ?? "").replace(/\s+/g, " ").trim() : visibleHtmlText(htmlBody);
  const subjectLength = Array.from(parsedHeaders.subject ?? "").length;
  const trackingPixelCount = images.filter(isTrackingPixel).length;
  const imageToTextRatio = roundedRatio(images.length, visibleText.length);
  const htmlCompatibilityWarnings = compatibilityWarnings(htmlBody);
  const hasListUnsubscribe = headerValues(headers, "List-Unsubscribe").length > 0;
  const hasTextAlternative = textBody !== null && textBody.trim().length > 0;

  const checks: ReadonlyArray<EmailDeliverabilityCheck> = [
    analyzeSpf(headers),
    analyzeDkim(headers),
    analyzeDmarc(headers),
    hasListUnsubscribe
      ? makeCheck(
          "list-unsubscribe",
          "pass",
          "List-Unsubscribe is present",
          "The message includes a List-Unsubscribe header.",
        )
      : makeCheck(
          "list-unsubscribe",
          "warning",
          "List-Unsubscribe is missing",
          "Bulk and subscription mail should include a List-Unsubscribe header.",
        ),
    htmlBody === null || hasTextAlternative
      ? makeCheck(
          "text-plain-alternative",
          "pass",
          "Plain-text content is available",
          htmlBody === null
            ? "The message is plain text and does not need a multipart alternative."
            : "The HTML message includes a text/plain alternative.",
        )
      : makeCheck(
          "text-plain-alternative",
          "warning",
          "Plain-text alternative is missing",
          "The HTML message does not include a non-empty text/plain alternative.",
        ),
    parsedHeaders.subject === null || parsedHeaders.subject.trim().length === 0
      ? makeCheck("subject-length", "warning", "Subject is missing", "The message has no subject.")
      : subjectLength <= EMAIL_SUBJECT_WARNING_LENGTH
        ? makeCheck(
            "subject-length",
            "pass",
            "Subject length is concise",
            `The subject is ${subjectLength} characters long.`,
          )
        : makeCheck(
            "subject-length",
            "warning",
            "Subject is long",
            `The subject is ${subjectLength} characters; ${EMAIL_SUBJECT_WARNING_LENGTH} or fewer is recommended.`,
          ),
    imageToTextRatio <= EMAIL_IMAGE_TO_TEXT_WARNING_RATIO
      ? makeCheck(
          "image-to-text-ratio",
          "pass",
          "Image-to-text ratio is balanced",
          `${images.length} images across ${visibleText.length} visible text characters.`,
        )
      : makeCheck(
          "image-to-text-ratio",
          "warning",
          "Image-to-text ratio is high",
          `${images.length} images across ${visibleText.length} visible text characters exceeds one image per 100 characters.`,
        ),
    trackingPixelCount === 0
      ? makeCheck(
          "tracking-pixels",
          "pass",
          "No tracking pixels detected",
          "No image with both dimensions at or below one pixel was found.",
        )
      : makeCheck(
          "tracking-pixels",
          "warning",
          "Tracking pixels detected",
          `${trackingPixelCount} image${trackingPixelCount === 1 ? "" : "s"} had both dimensions at or below one pixel.`,
        ),
    htmlCompatibilityWarnings.length === 0
      ? makeCheck(
          "html-compatibility",
          "pass",
          "No known HTML compatibility risks detected",
          "The static compatibility rule table did not match this message.",
        )
      : makeCheck(
          "html-compatibility",
          "warning",
          "HTML compatibility risks detected",
          `${htmlCompatibilityWarnings.length} static compatibility rule${htmlCompatibilityWarnings.length === 1 ? "" : "s"} matched.`,
        ),
  ];

  return {
    version: EMAIL_DELIVERABILITY_ENGINE_VERSION,
    checks,
    metrics: {
      subjectLength,
      imageCount: images.length,
      visibleTextCharacters: visibleText.length,
      imageToTextRatio,
      trackingPixelCount,
    },
    htmlCompatibilityWarnings,
  };
};
