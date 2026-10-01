import type {
  AvailableXcode,
  InstalledXcode,
  XcodeJob,
  XcodePlatform,
  XcodeStatus,
  XcodeStep,
  XcodeStepId,
  XcodeUpdate,
} from "@spiritdevs/contracts/xcode";

/** What an Xcode screen renders: the last inventory plus the newest job snapshot. */
export interface XcodeView {
  readonly status: XcodeStatus | null;
  readonly job: XcodeJob | null;
}

export const EMPTY_XCODE_VIEW: XcodeView = { status: null, job: null };

/** Download ticks carry only the job, so the last inventory is kept across them. */
export function applyXcodeUpdate(view: XcodeView, update: XcodeUpdate): XcodeView {
  return update.kind === "status"
    ? { status: update.status, job: update.status.job }
    : { status: view.status, job: update.job };
}

export const XCODE_PLATFORMS: ReadonlyArray<XcodePlatform> = ["iOS", "watchOS", "tvOS"];

export const XCODE_STEP_LABELS: Readonly<Record<XcodeStepId, string>> = {
  check: "Check the Mac",
  download: "Download Xcode",
  expand: "Expand and verify",
  move: "Move to Applications",
  license: "Accept the license",
  select: "Select Xcode",
  "first-launch": "Install components",
  runtimes: "Download platforms",
  helpers: "Install device support",
};

export const XCODE_JOB_STATE_LABELS: Readonly<Record<XcodeJob["state"], string>> = {
  running: "In progress",
  "needs-admin": "Needs admin approval on the Mac",
  "needs-reauth": "Sign in to your Apple ID again",
  interrupted: "Interrupted",
  failed: "Failed",
  cancelling: "Cancelling…",
  cancelled: "Cancelled",
  completed: "Done",
};

/** Spoken with each step, since the step icons are decorative. */
export const XCODE_STEP_STATE_LABELS: Readonly<Record<XcodeStep["state"], string>> = {
  pending: "Not started",
  running: "In progress",
  "needs-admin": "Needs admin approval",
  completed: "Done",
  skipped: "Skipped",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * What a polite live region says when a job reaches a state that needs the user or ends it. Other
 * states, including download ticks, stay silent.
 */
export function xcodeJobAnnouncement(job: XcodeJob | null, status: XcodeStatus | null): string {
  if (job === null) return "";
  const title = xcodeJobTitle(job, status);
  switch (job.state) {
    case "needs-admin":
      return `${title}: needs admin approval on the Mac.`;
    case "needs-reauth":
      return `${title}: sign in to your Apple ID again to continue.`;
    case "failed":
      return `${title} failed.`;
    case "completed":
      return `${title}.`;
    default:
      return "";
  }
}

/** Identifies one admin step of one job, so an approval is not mistaken for another step's. */
export function xcodeAdminStepKey(job: XcodeJob | null): string | null {
  if (job === null || job.state !== "needs-admin") return null;
  const step = job.steps.find((candidate) => candidate.state === "needs-admin");
  return step ? `${job.id}:${step.id}` : null;
}

/**
 * Keeps an approval only while its job is still waiting on that step. A dismissed prompt fails the
 * job, so a retried step asks for approval again instead of waiting forever.
 */
export function nextXcodeAdminApproval(
  approved: string | null,
  job: XcodeJob | null,
): string | null {
  return approved !== null && approved === xcodeAdminStepKey(job) ? approved : null;
}

/** The host holds one job at a time; these states block starting another. */
export function isXcodeJobActive(job: XcodeJob | null): boolean {
  return (
    job !== null &&
    (job.state === "running" ||
      job.state === "needs-admin" ||
      job.state === "needs-reauth" ||
      job.state === "interrupted" ||
      job.state === "cancelling")
  );
}

export function canRetryXcodeJob(job: XcodeJob): boolean {
  return (
    job.state === "failed" ||
    job.state === "cancelled" ||
    job.state === "interrupted" ||
    job.state === "needs-reauth"
  );
}

export function canCancelXcodeJob(job: XcodeJob): boolean {
  return job.state !== "completed" && job.state !== "cancelled" && job.state !== "cancelling";
}

/** The selected Xcode; an installed but unselected one still needs a select step. */
export function usableXcode(status: XcodeStatus): InstalledXcode | null {
  return status.installed.find((xcode) => xcode.selected) ?? null;
}

/**
 * The simulator runtime major version an Xcode ships with. Since Xcode 26 the platforms share its
 * number; before that iOS and tvOS ran two ahead and watchOS five behind. Null for versions this
 * table does not know.
 */
export function xcodeRuntimeMajor(xcodeVersion: string, platform: XcodePlatform): number | null {
  const major = Number.parseInt(xcodeVersion, 10);
  if (!Number.isFinite(major) || major < 11) return null;
  if (major >= 26) return major;
  return platform === "watchOS" ? major - 5 : major + 2;
}

/**
 * Platforms whose runtime for the selected Xcode is not installed and usable. An older runtime (iOS
 * 18 beside Xcode 26) or one simctl marks unavailable does not count; when the version is unknown
 * any available runtime does.
 */
export function missingXcodePlatforms(status: XcodeStatus): ReadonlyArray<XcodePlatform> {
  const selected = usableXcode(status);
  if (selected === null) return [];
  return XCODE_PLATFORMS.filter((platform) => {
    const major = xcodeRuntimeMajor(selected.version, platform);
    return !status.runtimes.some(
      (runtime) =>
        runtime.platform === platform &&
        runtime.installed &&
        runtime.available &&
        (major === null || Number.parseInt(runtime.version, 10) === major),
    );
  });
}

/** Numeric dotted-version comparison; "26.1" sorts after "26.0.1". */
export function compareXcodeVersions(a: string, b: string): number {
  const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** Newest release first, then older releases, then betas. The first release is recommended. */
export function orderAvailableXcodes(available: ReadonlyArray<AvailableXcode>): {
  readonly recommended: AvailableXcode | null;
  readonly ordered: ReadonlyArray<AvailableXcode>;
} {
  const ordered = available.toSorted(
    (a, b) => Number(a.beta) - Number(b.beta) || compareXcodeVersions(b.version, a.version),
  );
  const recommended = ordered[0] && !ordered[0].beta ? ordered[0] : null;
  return { recommended, ordered };
}

const GiB = 1024 ** 3;
// Mirrors the host's budget: each platform reserves 15 GiB on top of the Xcode itself.
const PLATFORM_BUDGET_BYTES = 15 * GiB;
const RUNTIMES_JOB_BUDGET_BYTES = 5 * GiB;

export function xcodeInstallRequiredBytes(
  version: Pick<AvailableXcode, "requiredBytes">,
  platforms: ReadonlyArray<XcodePlatform>,
): number {
  return version.requiredBytes + platforms.length * PLATFORM_BUDGET_BYTES;
}

export function xcodeRuntimesRequiredBytes(platforms: ReadonlyArray<XcodePlatform>): number {
  return RUNTIMES_JOB_BUDGET_BYTES + platforms.length * PLATFORM_BUDGET_BYTES;
}

/** Bytes missing on the Mac, or null when there is room or free space is unknown. */
export function diskShortfall(requiredBytes: number, freeBytes: number | null): number | null {
  if (freeBytes === null || freeBytes >= requiredBytes) return null;
  return requiredBytes - freeBytes;
}

/** Binary units labelled GB, matching Finder's rounding closely enough for a disk budget. */
export function formatXcodeBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.max(0, Math.round(bytes))} B`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 || unit < 2 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

export function formatXcodeEta(seconds: number): string {
  if (seconds < 60) return "less than a minute left";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `about ${minutes} min left`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `about ${hours} h left` : `about ${hours} h ${rest} min left`;
}

export interface XcodeDownloadDescription {
  /** 0–1, or null when the archive size is unknown. */
  readonly fraction: number | null;
  readonly amount: string;
  readonly speed: string | null;
  readonly eta: string | null;
}

export function describeXcodeDownload(
  progress: NonNullable<XcodeStep["progress"]>,
): XcodeDownloadDescription {
  const { bytes, total, bytesPerSecond } = progress;
  const known = total !== null && total > 0;
  const speed = bytesPerSecond > 0 ? `${formatXcodeBytes(bytesPerSecond)}/s` : null;
  return {
    fraction: known ? Math.min(1, bytes / total) : null,
    amount: known
      ? `${formatXcodeBytes(bytes)} of ${formatXcodeBytes(total)}`
      : formatXcodeBytes(bytes),
    speed,
    eta:
      known && bytesPerSecond > 0 && bytes < total
        ? formatXcodeEta((total - bytes) / bytesPerSecond)
        : null,
  };
}

export interface XcodeJobSummary {
  /** Steps that apply to this job, in order; skipped steps are left out. */
  readonly steps: ReadonlyArray<XcodeStep & { readonly label: string }>;
  /** The step in progress, waiting or failed; null once every step is settled. */
  readonly current: (XcodeStep & { readonly label: string }) | null;
  readonly completed: number;
  readonly total: number;
  /** Overall 0–1, counting a running download by its bytes. */
  readonly fraction: number;
}

export function summarizeXcodeJob(job: XcodeJob): XcodeJobSummary {
  const steps = job.steps
    .filter((step) => step.state !== "skipped")
    .map((step) => ({ ...step, label: XCODE_STEP_LABELS[step.id] }));
  const completed = steps.filter((step) => step.state === "completed").length;
  const current =
    steps.find(
      (step) =>
        step.state === "running" ||
        step.state === "needs-admin" ||
        step.state === "failed" ||
        step.state === "cancelled",
    ) ??
    steps.find((step) => step.state === "pending") ??
    null;
  const partial =
    current?.state === "running" && current.progress?.total
      ? Math.min(1, current.progress.bytes / current.progress.total)
      : 0;
  return {
    steps,
    current,
    completed,
    total: steps.length,
    fraction: steps.length === 0 ? 0 : (completed + partial) / steps.length,
  };
}

function lastPathComponent(path: string): string {
  return path.split("/").findLast((part) => part.length > 0) ?? path;
}

/** "Installing Xcode 26.1", or the app name for select and runtime jobs. */
export function xcodeJobTitle(job: XcodeJob, status: XcodeStatus | null): string {
  const version =
    status?.available.find((xcode) => xcode.id === job.versionId)?.version ??
    status?.installed.find((xcode) => xcode.path === job.path)?.version;
  const name = version ? `Xcode ${version}` : lastPathComponent(job.path).replace(/\.app$/u, "");
  switch (job.kind) {
    case "install":
      return job.state === "completed" ? `Installed ${name}` : `Installing ${name}`;
    case "select":
      return job.state === "completed" ? `Selected ${name}` : `Selecting ${name}`;
    case "runtimes":
      return job.state === "completed"
        ? `Added ${job.platforms.join(", ")} to ${name}`
        : `Adding ${job.platforms.join(", ")} to ${name}`;
  }
}
