import type {
  LocalReleaseArchive,
  ReleaseAction,
  ReleaseOrganizer,
} from "@spiritdevs/contracts/releases";

export type ReleasesTab = "release" | "organizer";

export interface ReleasesSearch {
  readonly project?: string | undefined;
  readonly tab?: "organizer" | undefined;
  /** Opens the confirmation for an intent an agent or another device prepared. */
  readonly intent?: string | undefined;
}

/**
 * `/releases?project=<projectKey>&tab=organizer&intent=<id>`. The Release tab is the default and
 * omitted.
 */
export function parseReleasesSearch(raw: Record<string, unknown>): ReleasesSearch {
  return {
    project: typeof raw.project === "string" && raw.project.trim() ? raw.project : undefined,
    tab: raw.tab === "organizer" ? "organizer" : undefined,
    intent: typeof raw.intent === "string" && raw.intent.trim() ? raw.intent : undefined,
  };
}

export const RELEASE_PLATFORMS = [
  { value: "IOS", label: "iOS" },
  { value: "MAC_OS", label: "macOS" },
  { value: "TV_OS", label: "tvOS" },
  { value: "VISION_OS", label: "visionOS" },
] as const;

export type ReleasePlatformValue = (typeof RELEASE_PLATFORMS)[number]["value"];

export function releasePlatformLabel(platform: string): string {
  return RELEASE_PLATFORMS.find((option) => option.value === platform)?.label ?? platform;
}

export interface ArchiveDraft {
  /** Relative to the checkout root, e.g. `ios/MyApp.xcworkspace`. */
  readonly projectFile: string;
  readonly scheme: string;
  readonly version: string;
  readonly platform: ReleasePlatformValue;
}

export const EMPTY_ARCHIVE_DRAFT: ArchiveDraft = {
  projectFile: "",
  scheme: "",
  version: "",
  platform: "IOS",
};

/** Mirrors the server's checks so the form explains a problem before the environment rejects it. */
export function archiveDraftProblem(draft: ArchiveDraft): string | null {
  const file = draft.projectFile.trim().replace(/\/+$/u, "");
  if (!file) return "Enter the .xcodeproj or .xcworkspace to archive.";
  if (!/\.(xcodeproj|xcworkspace)$/u.test(file)) return "Choose a .xcodeproj or .xcworkspace file.";
  if (!draft.scheme.trim()) return "Enter the scheme to archive.";
  if (!/^\d+(?:\.\d+){0,2}$/u.test(draft.version.trim()))
    return "Use a numeric version such as 1.2 or 1.2.3.";
  return null;
}

/** The environment needs an absolute path. Absolute input is kept; relative input joins the root. */
export function resolveArchiveProjectPath(workspaceRoot: string, projectFile: string): string {
  const file = projectFile.trim().replace(/\/+$/u, "");
  if (file.startsWith("/")) return file;
  return `${workspaceRoot.replace(/\/+$/u, "")}/${file.replace(/^\.\//u, "")}`;
}

/** Builds Apple has finished processing; only these can go to testers or review. */
export function processedBuilds(organizer: ReleaseOrganizer | null) {
  return (organizer?.builds ?? []).filter((build) => build.processingState === "VALID");
}

export function buildLabel(build: { version: string | null; buildNumber: string }): string {
  return build.version === null
    ? `Build ${build.buildNumber}`
    : `${build.version} (${build.buildNumber})`;
}

export interface ReleaseActionRow {
  readonly label: string;
  readonly value: string;
}

export interface ReleaseActionSummary {
  readonly title: string;
  readonly confirmLabel: string;
  readonly rows: ReadonlyArray<ReleaseActionRow>;
  /** What the user is accepting by confirming. Shown verbatim, never collapsed. */
  readonly consequence: string;
}

/**
 * Everything the confirmation dialog shows. Unknown IDs stay visible as IDs so a stale catalogue
 * cannot hide what will be sent.
 */
export function describeReleaseAction(
  action: ReleaseAction,
  context: {
    readonly organizer: ReleaseOrganizer | null;
    readonly archives: ReadonlyArray<LocalReleaseArchive>;
  },
): ReleaseActionSummary {
  const build = (id: string) => {
    const match = context.organizer?.builds.find((candidate) => candidate.id === id);
    return match ? buildLabel(match) : id;
  };
  switch (action.kind) {
    case "upload": {
      const archive = context.archives.find((candidate) => candidate.id === action.archiveId);
      return {
        title: "Upload to App Store Connect",
        confirmLabel: "Confirm and upload",
        rows: [
          { label: "Version", value: `${action.version} (${action.buildNumber})` },
          { label: "Platform", value: releasePlatformLabel(action.platform) },
          ...(archive
            ? [
                { label: "Bundle ID", value: archive.bundleId },
                { label: "Scheme", value: archive.scheme },
                { label: "Size", value: formatBytes(archive.artifactBytes) },
              ]
            : [{ label: "Archive", value: action.archiveId }]),
          { label: "SHA-256", value: action.artifactSha256 },
        ],
        consequence:
          "The build is sent to Apple. An uploaded build can't be taken back, and its build number can't be reused.",
      };
    }
    case "testflight": {
      const groups = action.groupIds.map(
        (id) => context.organizer?.groups.find((group) => group.id === id)?.name ?? id,
      );
      return {
        title: action.submitForReview ? "Send to TestFlight and beta review" : "Send to TestFlight",
        confirmLabel: action.submitForReview ? "Confirm and submit" : "Confirm and send",
        rows: [
          { label: "Build", value: build(action.buildId) },
          { label: "Groups", value: groups.length ? groups.join(", ") : "None" },
          { label: "What to test", value: action.whatsNew.trim() || "(empty)" },
          { label: "Language", value: action.locale },
          { label: "Beta review", value: action.submitForReview ? "Submit" : "Don't submit" },
        ],
        consequence:
          "Testers in these groups can get the build as soon as Apple allows it. Removing a build from a group is done in App Store Connect.",
      };
    }
    case "app-store": {
      const version = context.organizer?.versions.find(
        (candidate) => candidate.id === action.versionId,
      );
      return {
        title: "Submit for App Store review",
        confirmLabel: "Confirm and submit",
        rows: [
          { label: "Build", value: build(action.buildId) },
          {
            label: "App Store version",
            value: version
              ? `${version.version} · ${releasePlatformLabel(version.platform)}`
              : action.versionId,
          },
        ],
        consequence:
          "The build is attached to this version and sent to App Review. Withdrawing a submission is done in App Store Connect.",
      };
    }
  }
}

export interface Page<Item> {
  readonly items: ReadonlyArray<Item>;
  readonly page: number;
  readonly pageCount: number;
}

/** Clamps `page` so a list that shrank after a refresh never shows an empty page. */
export function paginate<Item>(items: ReadonlyArray<Item>, page: number, size: number): Page<Item> {
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(0, page), pageCount - 1);
  return { items: items.slice(current * size, (current + 1) * size), page: current, pageCount };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const units = ["KB", "MB", "GB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/** ASC dates are ISO strings or null. */
export function formatAscDate(iso: string | null): string {
  if (iso === null) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/** Apple state strings such as `READY_FOR_REVIEW` read as "Ready for review"; null as a dash. */
export function formatAscState(state: string | null): string {
  if (state === null) return "—";
  const words = state.toLowerCase().replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Release RPCs fail with ReleaseError, AppleError or EnvironmentAuthorizationError; Cloud calls with
 * ConvexError data. All carry a message that is safe to show.
 */
export function describeReleaseFailure(error: unknown, fallback: string): string {
  if (typeof error !== "object" || error === null) return fallback;
  const source =
    "data" in error && typeof error.data === "object" && error.data !== null ? error.data : error;
  const message =
    "message" in source && typeof source.message === "string" ? source.message.trim() : "";
  if ("_tag" in error || "data" in error) return message || fallback;
  return fallback;
}
