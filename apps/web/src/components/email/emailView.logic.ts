/**
 * Everything the Email view decides that does not need the DOM: URL shape, device presets, and the
 * sandboxed preview document.
 *
 * The preview builder is the load-bearing part. A captured message is untrusted HTML from whatever
 * a developer's app happened to send, so it is rendered in a fully sandboxed `srcdoc` iframe with
 * a `<meta>` CSP that names exactly what may load. Remote images and stylesheets are off by
 * default the way a real mail client has them: it keeps a preview from firing someone's tracking
 * pixel, which is also what lets the Metadata tab report the pixel count instead of triggering it.
 *
 * @module components/email/emailView.logic
 */
import type { EmailAddress, EmailInboxScope, ProjectId } from "@spiritdevs/contracts";

// ── URL ────────────────────────────────────────────────────────────────

export const EMAIL_READING_TABS = ["preview", "metadata", "deliverability", "raw"] as const;
export type EmailReadingTab = (typeof EMAIL_READING_TABS)[number];
export const DEFAULT_EMAIL_READING_TAB: EmailReadingTab = "preview";

export const EMAIL_READING_TAB_LABELS: Readonly<Record<EmailReadingTab, string>> = {
  preview: "Preview",
  metadata: "Metadata",
  deliverability: "Deliverability",
  raw: "Raw",
};

export const ALL_EMAIL_SCOPE_PARAM = "all";
export const UNASSIGNED_EMAIL_SCOPE_PARAM = "unassigned";

export interface EmailSearch {
  /** `all`, `unassigned`, or a project id. Absent means All mail. */
  readonly inbox: string | undefined;
  readonly message: string | undefined;
  readonly tab: EmailReadingTab | undefined;
  /** Absent rather than `false`: the only thing this param ever says is "not the mailbox". */
  readonly analytics: true | undefined;
}

export type EmailSearchPatch = Partial<{
  readonly inbox: string | undefined;
  readonly message: string | undefined;
  readonly tab: EmailReadingTab | undefined;
  readonly analytics: true | undefined;
}>;

function optionalParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function parseEmailSearch(raw: Record<string, unknown>): EmailSearch {
  const tab = raw.tab;
  return {
    inbox: optionalParam(raw.inbox),
    message: optionalParam(raw.message),
    tab: EMAIL_READING_TABS.includes(tab as EmailReadingTab) ? (tab as EmailReadingTab) : undefined,
    analytics: raw.analytics === true || raw.analytics === "true" ? true : undefined,
  };
}

/** An unrecognised param reads as All mail rather than as an empty inbox nobody can leave. */
export function emailScopeFromParam(param: string | undefined): EmailInboxScope {
  if (param === undefined || param === ALL_EMAIL_SCOPE_PARAM) return { type: "all" };
  if (param === UNASSIGNED_EMAIL_SCOPE_PARAM) return { type: "unassigned" };
  return { type: "project", projectId: param as ProjectId };
}

/** All mail is the default, so it is written as an absent param rather than `?inbox=all`. */
export function emailScopeParam(scope: EmailInboxScope): string | undefined {
  if (scope.type === "all") return undefined;
  return scope.type === "unassigned" ? UNASSIGNED_EMAIL_SCOPE_PARAM : scope.projectId;
}

export function emailReadingTab(search: EmailSearch): EmailReadingTab {
  return search.tab ?? DEFAULT_EMAIL_READING_TAB;
}

// ── Device sizes ───────────────────────────────────────────────────────

export interface EmailDevicePreset {
  readonly id: "desktop" | "tablet" | "mobile";
  readonly label: string;
  readonly width: number;
}

/**
 * Deliberately not `PREVIEW_VIEWPORT_PRESET_IDS`. That catalog is device-hardware oriented
 * (`iphone-se`, `nest-hub`), which is the wrong axis for mail: email layout convention is a 600px
 * content table, and "Nest Hub Max" as an email preview size is noise.
 */
export const EMAIL_DEVICE_PRESETS: ReadonlyArray<EmailDevicePreset> = Object.freeze([
  { id: "desktop", label: "Desktop", width: 1000 },
  { id: "tablet", label: "Tablet", width: 768 },
  { id: "mobile", label: "Mobile", width: 375 },
]);

export const DEFAULT_EMAIL_PREVIEW_WIDTH = 1000;
/** Below this nothing readable survives; above it no mail client has ever rendered. */
export const MIN_EMAIL_PREVIEW_WIDTH = 280;
export const MAX_EMAIL_PREVIEW_WIDTH = 1400;

export function clampEmailPreviewWidth(width: number): number {
  if (!Number.isFinite(width)) return DEFAULT_EMAIL_PREVIEW_WIDTH;
  return Math.round(Math.min(MAX_EMAIL_PREVIEW_WIDTH, Math.max(MIN_EMAIL_PREVIEW_WIDTH, width)));
}

/** Which preset button lights up, or null while the width is freeform. */
export function emailPresetForWidth(width: number): EmailDevicePreset["id"] | null {
  return EMAIL_DEVICE_PRESETS.find((preset) => preset.width === width)?.id ?? null;
}

// ── Preview document ───────────────────────────────────────────────────

/**
 * No `allow-scripts` and no `allow-same-origin`: the document renders in an opaque origin with
 * scripting off, so nothing inside it can reach the app, the network, or the top frame. An empty
 * sandbox attribute is the strictest value there is, and it is spelled out here so a future edit
 * has to be deliberate about widening it.
 */
export const EMAIL_PREVIEW_SANDBOX = "";

const BLOCKED_REMOTE_CSP = [
  "default-src 'none'",
  "img-src data: cid:",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "media-src data:",
  "script-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * Remote loads are opened for images, stylesheets, and fonts only, and only on request. Scripts,
 * objects, frames, and form posts stay shut at every setting — "load remote content" is a question
 * about pictures, not about what the message may execute.
 */
const ALLOWED_REMOTE_CSP = [
  "default-src 'none'",
  "img-src data: cid: https: http:",
  "style-src 'unsafe-inline' https: http:",
  "font-src data: https: http:",
  "media-src data: https: http:",
  "script-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/** Matches an `http(s)` or protocol-relative reference in an attribute or a CSS `url()`. */
const REMOTE_REFERENCE = /(?:src|srcset|href|background|url\()\s*=?\s*["'(]?\s*(?:https?:)?\/\//i;

/**
 * Whether the message asks for anything off the machine, which is what decides if the blocked
 * banner is worth showing. A miss costs nothing: the CSP is the enforcement, this is the label.
 */
export function hasRemoteEmailContent(html: string | null): boolean {
  return html !== null && REMOTE_REFERENCE.test(html);
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * The frame's own styling, applied to the document body rather than to the message: a captured
 * email brings its own CSS and this only has to keep an unstyled one legible.
 */
const PREVIEW_BASE_STYLE = `
  html, body { margin: 0; padding: 0; background: #ffffff; color: #18181b; }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
  .t3-email-plain { margin: 0; padding: 16px; white-space: pre-wrap; word-break: break-word; }
  .t3-email-empty { margin: 0; padding: 16px; color: #71717a; font-style: italic; }
`;

export interface EmailPreviewSource {
  readonly htmlBody: string | null;
  readonly textBody: string | null;
}

/**
 * The `srcdoc` for one message at one remote-content setting.
 *
 * HTML wins when the message has it, which is what the recipient's client would show; a text-only
 * message is escaped into a `<pre>`-alike so a plain-text mail that happens to contain markup is
 * read rather than rendered.
 */
export function buildEmailPreviewDocument(
  source: EmailPreviewSource,
  options: { readonly allowRemoteContent: boolean },
): string {
  const csp = options.allowRemoteContent ? ALLOWED_REMOTE_CSP : BLOCKED_REMOTE_CSP;
  const body =
    source.htmlBody !== null && source.htmlBody.trim().length > 0
      ? source.htmlBody
      : source.textBody !== null && source.textBody.trim().length > 0
        ? `<pre class="t3-email-plain">${escapeHtml(source.textBody)}</pre>`
        : `<p class="t3-email-empty">This message has no body.</p>`;

  return [
    "<!doctype html>",
    '<html lang="en"><head>',
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '<meta name="referrer" content="no-referrer">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<style>${PREVIEW_BASE_STYLE}</style>`,
    "</head><body>",
    body,
    "</body></html>",
  ].join("");
}

// ── Formatting ─────────────────────────────────────────────────────────

export function formatEmailAddress(address: EmailAddress): string {
  const name = address.name?.trim() ?? "";
  return name.length > 0 ? `${name} <${address.address}>` : address.address;
}

/** The list row wants the human half; the header wants the whole thing. */
export function emailAddressDisplayName(address: EmailAddress): string {
  const name = address.name?.trim() ?? "";
  return name.length > 0 ? name : address.address;
}

export function formatEmailAddressList(
  addresses: ReadonlyArray<EmailAddress>,
  options?: { readonly empty?: string },
): string {
  if (addresses.length === 0) return options?.empty ?? "—";
  return addresses.map(formatEmailAddress).join(", ");
}

const BYTE_UNITS = ["B", "KB", "MB", "GB"] as const;

export function formatEmailBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${BYTE_UNITS[unit]}`;
}

export function formatEmailDurationMs(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "—";
  return milliseconds < 1000
    ? `${Math.round(milliseconds)} ms`
    : `${Math.round(milliseconds / 100) / 10} s`;
}

/**
 * A mail-client timestamp: the clock for today, the date for this year, the year for anything
 * older. `now` is passed in so the column is a pure function of the row and the render.
 */
export function formatEmailTimestamp(iso: string, now: Date): string {
  const received = new Date(iso);
  if (Number.isNaN(received.getTime())) return "—";
  const sameDay =
    received.getFullYear() === now.getFullYear() &&
    received.getMonth() === now.getMonth() &&
    received.getDate() === now.getDate();
  if (sameDay) {
    return `${String(received.getHours()).padStart(2, "0")}:${String(received.getMinutes()).padStart(2, "0")}`;
  }
  const day = String(received.getDate()).padStart(2, "0");
  const month = received.toLocaleString("en-US", { month: "short" });
  return received.getFullYear() === now.getFullYear()
    ? `${month} ${day}`
    : `${month} ${day}, ${received.getFullYear()}`;
}
