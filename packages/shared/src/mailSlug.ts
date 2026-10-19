import { EMAIL_MAIL_SLUG_MAX_LENGTH } from "@spiritdevs/contracts";

export const MAIL_SLUG_MAX_LENGTH = EMAIL_MAIL_SLUG_MAX_LENGTH;

function directoryBasename(path: string): string {
  const withoutTrailingSeparators = path.replace(/[\\/]+$/g, "");
  const separatorIndex = Math.max(
    withoutTrailingSeparators.lastIndexOf("/"),
    withoutTrailingSeparators.lastIndexOf("\\"),
  );
  return withoutTrailingSeparators.slice(separatorIndex + 1);
}

function normalizeMailSlug(value: string): string {
  const slug = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAIL_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");

  return slug || "project";
}

/**
 * Derives a DNS-safe mail slug from a project directory and claims the first free numeric suffix.
 * Existing slugs are compared case-insensitively so a hand-edited value cannot create an
 * address that behaves differently across SMTP clients.
 */
export function deriveMailSlug(projectDirectory: string, existingSlugs: Iterable<string>): string {
  const base = normalizeMailSlug(directoryBasename(projectDirectory));
  const claimed = new Set(Array.from(existingSlugs, (slug) => slug.toLowerCase()));

  if (!claimed.has(base)) {
    return base;
  }

  for (let collision = 2; ; collision += 1) {
    const suffix = `-${collision}`;
    const stem = base.slice(0, MAIL_SLUG_MAX_LENGTH - suffix.length).replace(/-+$/g, "");
    const candidate = `${stem}${suffix}`;
    if (!claimed.has(candidate)) {
      return candidate;
    }
  }
}
