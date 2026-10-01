import type { DeviceSummary } from "@spiritdevs/contracts";
import type {
  SimBuildAction,
  SimBuildContainer,
  SimBuildDiagnostic,
  SimBuildDiscovery,
  SimBuildFailure,
  SimBuildJob,
  SimBuildLogChunk,
  SimBuildPhase,
} from "@spiritdevs/contracts/simBuild";

export const SIM_BUILD_PHASE_LABELS: Record<SimBuildPhase, string> = {
  resolving: "Resolving",
  building: "Building",
  installing: "Installing",
  launching: "Launching",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

export const SIM_BUILD_ACTION_LABELS: Record<SimBuildAction, string> = {
  build: "Build",
  run: "Run",
  test: "Test",
};

/** The happy path for an action; the card marks steps before the current phase as done. */
export function simBuildSteps(action: SimBuildAction): readonly SimBuildPhase[] {
  return action === "run"
    ? ["resolving", "building", "installing", "launching", "running"]
    : ["resolving", "building", "completed"];
}

/** A typed SimBuildError from a failed command, or null for transport and other failures. */
export function simBuildFailure(error: unknown): SimBuildFailure | null {
  if (typeof error !== "object" || error === null) return null;
  const candidate = error as { _tag?: unknown; code?: unknown; message?: unknown };
  return candidate._tag === "SimBuildError" &&
    typeof candidate.code === "string" &&
    typeof candidate.message === "string"
    ? ({ code: candidate.code, message: candidate.message } as SimBuildFailure)
    : null;
}

/** Why this thread cannot build onto the device at all; null when discovery is worth trying. */
export function simBuildBlocker(input: {
  readonly device: Pick<DeviceSummary, "hostId" | "platform">;
  readonly hostSupport: "mac" | "not-mac" | "unknown";
  readonly projectId: string | null;
}): string | null {
  if (input.device.platform !== "ios") return "Builds run on iOS simulators.";
  if (input.device.hostId !== "local")
    return "Builds run on this environment's Mac. Simulators on SSH device hosts can't receive builds yet.";
  if (input.hostSupport === "not-mac")
    return "Simulator builds need this project's environment to run on a Mac.";
  if (input.projectId === null) return "Attach a project to this thread to build it.";
  return null;
}

export interface SimBuildSelection {
  readonly containerPath: string;
  readonly scheme: string;
  readonly configuration: string | null;
  readonly target: string | null;
  readonly action: SimBuildAction;
}

/** Prefers a workspace (CocoaPods and RN projects build through it), then its first scheme. */
export function defaultSimBuildSelection(
  discovery: Pick<SimBuildDiscovery, "containers">,
  previous: SimBuildSelection | null,
): SimBuildSelection | null {
  const kept = previous
    ? discovery.containers.find((container) => container.path === previous.containerPath)
    : undefined;
  if (previous && kept?.schemes.includes(previous.scheme)) return previous;
  const container =
    kept ??
    discovery.containers.find((candidate) => candidate.kind === "workspace") ??
    discovery.containers[0];
  const scheme = container?.schemes[0];
  if (!container || !scheme) return null;
  return {
    containerPath: container.path,
    scheme,
    configuration: null,
    target: null,
    action: previous?.action ?? "run",
  };
}

/** Xcode lists targets and configurations on projects; a workspace borrows its projects' lists. */
export function simBuildContainerInventory(
  containers: readonly SimBuildContainer[],
  containerPath: string,
): { readonly targets: readonly string[]; readonly configurations: readonly string[] } {
  const container = containers.find((candidate) => candidate.path === containerPath);
  if (!container) return { targets: [], configurations: [] };
  const sources =
    container.kind === "workspace"
      ? containers.filter((candidate) => candidate.kind === "project")
      : [container];
  return {
    targets: [...new Set(sources.flatMap((source) => source.targets))],
    configurations: [...new Set(sources.flatMap((source) => source.configurations))],
  };
}

export const SIM_BUILD_DIAGNOSTIC_LIMIT = 50;

/** Errors first, newest output last; bounded so a noisy build cannot flood the card. */
export function simBuildDiagnostics(logs: readonly SimBuildLogChunk[]): {
  readonly items: readonly (SimBuildDiagnostic & { readonly key: string })[];
  readonly errors: number;
  readonly warnings: number;
} {
  const all = logs.flatMap((log) =>
    log.diagnostics.map((diagnostic, index) => ({
      ...diagnostic,
      key: `${log.sequence}:${index}`,
    })),
  );
  const errors = all.filter((diagnostic) => diagnostic.severity === "error");
  const warnings = all.filter((diagnostic) => diagnostic.severity === "warning");
  return {
    items: [...errors, ...warnings].slice(0, SIM_BUILD_DIAGNOSTIC_LIMIT),
    errors: errors.length,
    warnings: warnings.length,
  };
}

/** The `path:line:column` form the environment's open-in-editor command understands. */
export function simBuildDiagnosticTarget(
  diagnostic: Pick<SimBuildDiagnostic, "file" | "line" | "column">,
): string | null {
  if (!diagnostic.file) return null;
  if (diagnostic.line === null) return diagnostic.file;
  return diagnostic.column === null
    ? `${diagnostic.file}:${diagnostic.line}`
    : `${diagnostic.file}:${diagnostic.line}:${diagnostic.column}`;
}

/** Workspace-relative label for a diagnostic location. */
export function simBuildDiagnosticLocation(
  diagnostic: Pick<SimBuildDiagnostic, "file" | "line" | "column">,
  workspaceRoot: string,
): string | null {
  if (!diagnostic.file) return null;
  const root = workspaceRoot.endsWith("/") ? workspaceRoot : `${workspaceRoot}/`;
  const file = diagnostic.file.startsWith(root)
    ? diagnostic.file.slice(root.length)
    : diagnostic.file;
  if (diagnostic.line === null) return file;
  return diagnostic.column === null
    ? `${file}:${diagnostic.line}`
    : `${file}:${diagnostic.line}:${diagnostic.column}`;
}

/** An active job wins; otherwise the newest one, so a finished run stays visible. */
export function currentSimBuildJob(jobs: readonly SimBuildJob[]): SimBuildJob | null {
  return (
    jobs.find((job) => !job.terminal) ??
    jobs.toSorted((a, b) => b.createdAt - a.createdAt)[0] ??
    null
  );
}

export function simBuildJobTitle(job: Pick<SimBuildJob, "action" | "scheme">, deviceName: string) {
  return `${SIM_BUILD_ACTION_LABELS[job.action]} ${job.scheme} on ${deviceName}`;
}
