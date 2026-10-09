import * as Schema from "effect/Schema";

/**
 * Settings for the desktop's built-in browser (Settings → Browser). They live in
 * client settings, so they belong to this machine and never sync.
 */

/** Where a link opens: Pathway's built-in browser, or the system default browser. */
export const BrowserLinkTarget = Schema.Literals(["browser", "external"]);
export type BrowserLinkTarget = typeof BrowserLinkTarget.Type;

/** Annotation screenshots: always, or only when the annotation has a region or drawing. */
export const BrowserAnnotationScreenshots = Schema.Literals(["always", "drag"]);
export type BrowserAnnotationScreenshots = typeof BrowserAnnotationScreenshots.Type;

/** Whether agents may read browsing history, and whether they ask first. */
export const BrowserHistoryAccess = Schema.Literals(["ask", "allow", "disabled"]);
export type BrowserHistoryAccess = typeof BrowserHistoryAccess.Type;

// ── Site settings: what websites may use ─────────────────────────

export const BROWSER_SITE_PERMISSIONS = [
  "camera",
  "microphone",
  "location",
  "notifications",
  "clipboard",
  "midi",
  "popups",
  "sound",
] as const;
export const BrowserSitePermission = Schema.Literals(BROWSER_SITE_PERMISSIONS);
export type BrowserSitePermission = typeof BrowserSitePermission.Type;

/** Ask prompts the user; pop-ups and sound have no prompt, so they take allow or block. */
export const BrowserSitePermissionValue = Schema.Literals(["ask", "allow", "block"]);
export type BrowserSitePermissionValue = typeof BrowserSitePermissionValue.Type;

export const BrowserSitePermissionMap = Schema.Struct({
  camera: Schema.optionalKey(BrowserSitePermissionValue),
  microphone: Schema.optionalKey(BrowserSitePermissionValue),
  location: Schema.optionalKey(BrowserSitePermissionValue),
  notifications: Schema.optionalKey(BrowserSitePermissionValue),
  clipboard: Schema.optionalKey(BrowserSitePermissionValue),
  midi: Schema.optionalKey(BrowserSitePermissionValue),
  popups: Schema.optionalKey(BrowserSitePermissionValue),
  sound: Schema.optionalKey(BrowserSitePermissionValue),
});
export type BrowserSitePermissionMap = typeof BrowserSitePermissionMap.Type;

export const BrowserSitePermissionException = Schema.Struct({
  /** A web origin, such as `https://meet.google.com`. */
  origin: Schema.String.check(Schema.isMaxLength(2048)),
  permissions: BrowserSitePermissionMap,
});
export type BrowserSitePermissionException = typeof BrowserSitePermissionException.Type;

export const BrowserSitePermissionSettings = Schema.Struct({
  /** Overrides of {@link DEFAULT_BROWSER_SITE_PERMISSIONS}; missing keys use it. */
  defaults: BrowserSitePermissionMap,
  sites: Schema.Array(BrowserSitePermissionException),
});
export type BrowserSitePermissionSettings = typeof BrowserSitePermissionSettings.Type;

export const DEFAULT_BROWSER_SITE_PERMISSIONS: Readonly<
  Record<BrowserSitePermission, BrowserSitePermissionValue>
> = {
  camera: "ask",
  microphone: "ask",
  location: "allow",
  notifications: "allow",
  clipboard: "allow",
  midi: "ask",
  popups: "allow",
  sound: "allow",
};

/** Permissions with no prompt: a request is decided immediately. */
export const BROWSER_SITE_PERMISSIONS_WITHOUT_PROMPT: ReadonlySet<BrowserSitePermission> = new Set([
  "popups",
  "sound",
]);

/**
 * The effective value for one origin: its exception, else the default. An
 * origin matches an exception exactly; there are no wildcards here.
 */
export function resolveBrowserSitePermission(
  settings: BrowserSitePermissionSettings,
  origin: string | null,
  permission: BrowserSitePermission,
): BrowserSitePermissionValue {
  const site =
    origin === null ? undefined : settings.sites.find((entry) => entry.origin === origin);
  return (
    site?.permissions[permission] ??
    settings.defaults[permission] ??
    DEFAULT_BROWSER_SITE_PERMISSIONS[permission]
  );
}

/** Records one site's decision, replacing any earlier one for that permission. */
export function setBrowserSitePermission(
  settings: BrowserSitePermissionSettings,
  origin: string,
  permission: BrowserSitePermission,
  value: BrowserSitePermissionValue | null,
): BrowserSitePermissionSettings {
  const existing = settings.sites.find((entry) => entry.origin === origin);
  const { [permission]: _previous, ...rest } = existing?.permissions ?? {};
  const permissions: BrowserSitePermissionMap =
    value === null ? rest : { ...rest, [permission]: value };
  const others = settings.sites.filter((entry) => entry.origin !== origin);
  return {
    ...settings,
    sites: Object.keys(permissions).length === 0 ? others : [...others, { origin, permissions }],
  };
}

// ── Agent permissions: what agents may do on a site ──────────────

export const BrowserAgentBrowseAccess = Schema.Literals(["allow", "approval", "block"]);
export type BrowserAgentBrowseAccess = typeof BrowserAgentBrowseAccess.Type;

export const BrowserAgentToggleAccess = Schema.Literals(["allow", "block"]);
export type BrowserAgentToggleAccess = typeof BrowserAgentToggleAccess.Type;

export const BrowserAgentAccess = Schema.Struct({
  browse: BrowserAgentBrowseAccess,
  download: BrowserAgentToggleAccess,
  /** Raw Chrome DevTools Protocol commands. Also needs full CDP access turned on. */
  cdp: BrowserAgentToggleAccess,
});
export type BrowserAgentAccess = typeof BrowserAgentAccess.Type;

export const BrowserAgentSitePolicy = Schema.Struct({
  /**
   * An origin, or an origin whose host starts with `*.` to cover subdomains,
   * such as `https://*.example.com`.
   */
  pattern: Schema.String.check(Schema.isMaxLength(2048)),
  browse: Schema.optionalKey(BrowserAgentBrowseAccess),
  download: Schema.optionalKey(BrowserAgentToggleAccess),
  cdp: Schema.optionalKey(BrowserAgentToggleAccess),
});
export type BrowserAgentSitePolicy = typeof BrowserAgentSitePolicy.Type;

export const BrowserAgentPermissions = Schema.Struct({
  defaults: BrowserAgentAccess,
  sites: Schema.Array(BrowserAgentSitePolicy),
});
export type BrowserAgentPermissions = typeof BrowserAgentPermissions.Type;

export const DEFAULT_BROWSER_SITE_PERMISSION_SETTINGS: BrowserSitePermissionSettings = {
  defaults: {},
  sites: [],
};

export const DEFAULT_BROWSER_AGENT_PERMISSIONS: BrowserAgentPermissions = {
  defaults: { browse: "allow", download: "allow", cdp: "block" },
  sites: [],
};

/**
 * Normalizes a site pattern typed by the user, or returns null when it isn't
 * one. Accepts `https://example.com`, `https://*.example.com`, and bare hosts.
 */
export function normalizeBrowserSitePattern(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const wildcard = /^([a-z]+:\/\/)\*\.(.+)$/i.exec(withScheme);
  const candidate = wildcard ? `${wildcard[1]}${wildcard[2]}` : withScheme;
  if (!URL.canParse(candidate)) return null;
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.hostname === "" || url.username !== "" || url.password !== "") return null;
  const port = url.port === "" ? "" : `:${url.port}`;
  return `${url.protocol}//${wildcard ? "*." : ""}${url.hostname}${port}`;
}

/** Whether a normalized site pattern covers a page's origin. */
export function browserSitePatternMatches(pattern: string, origin: string): boolean {
  if (!URL.canParse(origin)) return false;
  const page = new URL(origin);
  const wildcard = /^([a-z]+:)\/\/\*\.(.+)$/i.exec(pattern);
  if (!wildcard) return pattern === page.origin;
  const [, protocol, hostAndPort] = wildcard;
  if (protocol !== page.protocol) return false;
  const host = page.port === "" ? page.hostname : `${page.hostname}:${page.port}`;
  return host === hostAndPort || host.endsWith(`.${hostAndPort}`);
}

/**
 * The access agents have on an origin. The most specific matching pattern
 * wins: an exact origin beats a wildcard, and a longer wildcard beats a shorter.
 */
export function resolveBrowserAgentAccess(
  permissions: BrowserAgentPermissions,
  origin: string | null,
): BrowserAgentAccess {
  if (origin === null) return permissions.defaults;
  const matches = permissions.sites
    .filter((site) => browserSitePatternMatches(site.pattern, origin))
    .toSorted(
      (a, b) =>
        Number(a.pattern.includes("*.")) - Number(b.pattern.includes("*.")) ||
        b.pattern.length - a.pattern.length,
    );
  const pick = <K extends keyof BrowserAgentAccess>(key: K): BrowserAgentAccess[K] =>
    (matches.find((site) => site[key] !== undefined)?.[key] as BrowserAgentAccess[K] | undefined) ??
    permissions.defaults[key];
  return { browse: pick("browse"), download: pick("download"), cdp: pick("cdp") };
}

/**
 * Replaces one site pattern's custom access. Keys missing from `access` use
 * the default; null, or an empty `access`, removes the site.
 */
export function setBrowserAgentSitePolicy(
  permissions: BrowserAgentPermissions,
  pattern: string,
  access: Partial<BrowserAgentAccess> | null,
): BrowserAgentPermissions {
  const others = permissions.sites.filter((site) => site.pattern !== pattern);
  const policy: BrowserAgentSitePolicy = { pattern, ...access };
  const hasCustomAccess = access !== null && Object.keys(access).length > 0;
  return { ...permissions, sites: hasCustomAccess ? [...others, policy] : others };
}

// ── Contact info ────────────────────────────────────────────────

export const BrowserAddress = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(64)),
  fullName: Schema.String.check(Schema.isMaxLength(256)),
  organization: Schema.String.check(Schema.isMaxLength(256)),
  streetAddress: Schema.String.check(Schema.isMaxLength(1024)),
  city: Schema.String.check(Schema.isMaxLength(256)),
  region: Schema.String.check(Schema.isMaxLength(256)),
  postalCode: Schema.String.check(Schema.isMaxLength(64)),
  country: Schema.String.check(Schema.isMaxLength(128)),
  phone: Schema.String.check(Schema.isMaxLength(64)),
  email: Schema.String.check(Schema.isMaxLength(320)),
});
export type BrowserAddress = typeof BrowserAddress.Type;

// ── Extensions ──────────────────────────────────────────────────

/** An unpacked Chrome extension the built-in browser loads from disk. */
export const BrowserExtensionSetting = Schema.Struct({
  path: Schema.String.check(Schema.isMaxLength(4096)),
  enabled: Schema.Boolean,
});
export type BrowserExtensionSetting = typeof BrowserExtensionSetting.Type;
