import {
  EMAIL_MAIL_SLUG_MAX_LENGTH,
  EmailMailSlug,
  type EmailProjectAttribution,
  type EmailProjectSettings,
  type ProjectId,
} from "@spiritdevs/contracts";

import type { EmailProject } from "./EmailProjectCatalog.ts";

function baseSlug(value: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, EMAIL_MAIL_SLUG_MAX_LENGTH)
    .replace(/-+$/g, "");
  return slug || "project";
}

function slugWithSuffix(base: string, suffix: number): EmailMailSlug {
  if (suffix === 1) return EmailMailSlug.make(base);
  const suffixText = `-${suffix}`;
  const prefix = base.slice(0, EMAIL_MAIL_SLUG_MAX_LENGTH - suffixText.length).replace(/-+$/g, "");
  return EmailMailSlug.make(`${prefix || "project"}${suffixText}`);
}

/** Keeps capture routing aligned with the current project catalog, preserving live overrides. */
export function reconcileEmailProjectSettings(input: {
  readonly projects: ReadonlyArray<EmailProject>;
  readonly configured: ReadonlyArray<EmailProjectSettings>;
}): ReadonlyArray<EmailProjectSettings> {
  const currentProjectIds = new Set(input.projects.map((project) => project.projectId));
  const retained = input.configured.filter((settings) => currentProjectIds.has(settings.projectId));
  const byProject = new Map(retained.map((settings) => [settings.projectId, settings]));
  const used = new Set(retained.map((settings) => settings.mailSlug));
  const next = [...retained];

  for (const project of input.projects) {
    if (byProject.has(project.projectId)) continue;
    const name = project.workspaceRoot
      ? project.workspaceRoot
          .replace(/[\\/]+$/g, "")
          .split(/[\\/]/)
          .at(-1) || project.title
      : project.title;
    const base = baseSlug(name);
    let suffix = 1;
    let mailSlug = slugWithSuffix(base, suffix);
    while (used.has(mailSlug)) {
      suffix += 1;
      mailSlug = slugWithSuffix(base, suffix);
    }
    used.add(mailSlug);
    next.push({
      projectId: project.projectId,
      mailSlug,
      capturePassword: null,
      retention: { maxMessages: null, maxAgeDays: null },
      toastMuted: false,
      twoFactorCodeRegex: null,
    });
  }

  return next;
}

function matchingProject(
  label: string,
  projects: ReadonlyArray<EmailProjectSettings>,
): EmailProjectSettings | undefined {
  const normalized = label.trim().toLowerCase();
  return projects.find((project) => project.mailSlug === normalized);
}

export function routeEmail(input: {
  readonly authUsername: string | null;
  readonly authPassword: string | null;
  readonly recipients: ReadonlyArray<string>;
  readonly projects: ReadonlyArray<EmailProjectSettings>;
}): EmailProjectAttribution {
  if (input.authUsername) {
    const project = matchingProject(input.authUsername, input.projects);
    if (project) {
      return {
        projectId: project.projectId,
        mailSlug: project.mailSlug,
        matchedBy: "auth-username",
        matchedValue: input.authUsername,
      };
    }
  }

  if (input.authPassword) {
    const password = input.authPassword.trim();
    const project = input.projects.find(
      ({ capturePassword }) => capturePassword !== null && capturePassword === password,
    );
    if (project) {
      return {
        projectId: project.projectId,
        mailSlug: project.mailSlug,
        matchedBy: "auth-password",
        matchedValue: password,
      };
    }
  }

  for (const recipient of input.recipients) {
    const separator = recipient.lastIndexOf("@");
    if (separator < 1) continue;
    const domain = recipient.slice(separator + 1).toLowerCase();
    if (!domain.endsWith(".test")) continue;
    const project = matchingProject(domain.slice(0, -5), input.projects);
    if (project) {
      return {
        projectId: project.projectId,
        mailSlug: project.mailSlug,
        matchedBy: "recipient-domain",
        matchedValue: recipient,
      };
    }
  }

  for (const recipient of input.recipients) {
    const separator = recipient.lastIndexOf("@");
    if (separator < 1) continue;
    const localPart = recipient.slice(0, separator);
    const plus = localPart.lastIndexOf("+");
    if (plus < 0 || plus === localPart.length - 1) continue;
    const project = matchingProject(localPart.slice(plus + 1), input.projects);
    if (project) {
      return {
        projectId: project.projectId,
        mailSlug: project.mailSlug,
        matchedBy: "recipient-plus-tag",
        matchedValue: recipient,
      };
    }
  }

  return {
    projectId: null,
    mailSlug: null,
    matchedBy: "unassigned",
    matchedValue: null,
  };
}

export function validateUniqueMailSlugs(
  projects: ReadonlyArray<EmailProjectSettings>,
): { readonly slug: string; readonly projectIds: ReadonlyArray<ProjectId> } | null {
  const bySlug = new Map<string, Array<ProjectId>>();
  for (const project of projects) {
    const projectIds = bySlug.get(project.mailSlug) ?? [];
    projectIds.push(project.projectId);
    bySlug.set(project.mailSlug, projectIds);
  }
  for (const [slug, projectIds] of bySlug) {
    if (projectIds.length > 1) return { slug, projectIds };
  }
  return null;
}
