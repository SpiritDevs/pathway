import type {
  DeviceHostSummary,
  DeviceServiceState,
  DeviceToolDrift,
  DeviceToolManifest,
} from "@spiritdevs/contracts";

export type DeviceDriftStatus = DeviceToolDrift["status"];

/** How one host's pinned helpers compare with its environment's manifest. */
export type DeviceHelperState = "current" | "behind" | "restart" | "unknown";

export interface DeviceToolCell {
  /** Null when the environment's Pathway release does not report drift. */
  readonly status: DeviceDriftStatus | null;
  readonly actual: string;
  readonly expected: string | null;
  readonly restartRequired: boolean;
}

export interface DeviceToolSyncRow<Id extends string = string> {
  readonly key: string;
  readonly environmentId: Id;
  readonly environmentLabel: string;
  readonly hostId: string;
  readonly hostLabel: string;
  readonly hostKind: DeviceHostSummary["kind"];
  readonly helperState: DeviceHelperState;
  /** The newest manifest among connected environments pins newer helpers than this one. */
  readonly olderRelease: boolean;
  /** Inventory is cached because the latest inspection failed. */
  readonly stale: boolean;
  readonly canUpdate: boolean;
  readonly columns: {
    readonly xcode: DeviceToolCell;
    readonly runtimes: DeviceToolCell;
    readonly hub: DeviceToolCell;
    readonly agent: DeviceToolCell;
  };
}

export type DeviceToolUpdateOutcome =
  | { readonly status: "pending" }
  | { readonly status: "success" }
  | { readonly status: "failed"; readonly message: string };

const HELPERS = ["hub", "agent", "serveSim"] as const;

const STATUS_RANK: Record<DeviceDriftStatus, number> = {
  match: 0,
  unknown: 1,
  different: 2,
  missing: 3,
};

export const deviceToolRowKey = (environmentId: string, hostId: string) =>
  `${environmentId}\u0000${hostId}`;

/** A missing or different pin outranks an unknown probe. */
export function worstDriftStatus(
  entries: ReadonlyArray<DeviceToolDrift>,
): DeviceDriftStatus | null {
  return entries.reduce<DeviceDriftStatus | null>(
    (worst, entry) =>
      worst === null || STATUS_RANK[entry.status] > STATUS_RANK[worst] ? entry.status : worst,
    null,
  );
}

export function hostHelperState(host: DeviceHostSummary): DeviceHelperState {
  const helpers = (host.drift ?? []).filter((entry) =>
    (HELPERS as ReadonlyArray<string>).includes(entry.tool),
  );
  if (helpers.length === 0) return "unknown";
  const worst = worstDriftStatus(helpers);
  if (worst === "missing" || worst === "different") return "behind";
  if (worst === "unknown") return "unknown";
  // Only a confirmed matching install can be waiting on a restart.
  return helpers.some((entry) => entry.restartRequired) ? "restart" : "current";
}

const RUNTIME_LABEL = { ios: "iOS", android: "Android" } as const;

function cell(entries: ReadonlyArray<DeviceToolDrift>, actual: string): DeviceToolCell {
  return {
    status: worstDriftStatus(entries),
    actual,
    expected: entries.length > 0 ? entries.map((entry) => entry.expected).join(" · ") : null,
    restartRequired:
      worstDriftStatus(entries) === "match" && entries.some((entry) => entry.restartRequired),
  };
}

/** Installed versions, newest last, or "None" once a completed check found nothing. */
function versionsLabel(entry: DeviceToolDrift | undefined): string {
  if (!entry) return "—";
  if (entry.status === "unknown" && entry.actual.length === 0) return "Unknown";
  return entry.actual.length > 0
    ? entry.actual.toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true })).join(", ")
    : "None";
}

export function hostToolColumns(host: DeviceHostSummary): DeviceToolSyncRow["columns"] {
  const drift = host.drift ?? [];
  const find = (tool: DeviceToolDrift["tool"]) => drift.filter((entry) => entry.tool === tool);
  const runtimes = [...find("iosRuntime"), ...find("androidRuntime")];
  const inventory = host.sdkInventory;
  const runtimeLabel = inventory
    ? inventory.runtimes.length > 0
      ? [...new Set(inventory.runtimes.map((r) => `${RUNTIME_LABEL[r.platform]} ${r.version}`))]
          .toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true }))
          .join(", ")
      : "None"
    : "—";
  return {
    xcode: cell(find("xcode"), inventory ? (inventory.xcode ?? "None") : "—"),
    runtimes: {
      ...cell(runtimes, runtimeLabel),
      expected:
        runtimes.length > 0
          ? runtimes
              .map(
                (entry) => `${entry.tool === "iosRuntime" ? "iOS" : "Android"} ${entry.expected}`,
              )
              .join(" · ")
          : null,
    },
    // serve-sim ships inside the hub release, so its drift reads as the hub's.
    hub: cell([...find("hub"), ...find("serveSim")], versionsLabel(find("hub")[0])),
    agent: cell(find("agent"), versionsLabel(find("agent")[0])),
  };
}

const compareVersions = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });

/** Orders manifests by the helpers they pin; a newer release pins newer helpers. */
export function compareManifests(a: DeviceToolManifest, b: DeviceToolManifest): number {
  return compareVersions(a.hub, b.hub) || compareVersions(a.agent, b.agent);
}

export function deviceToolSyncRows<Id extends string>(
  environments: ReadonlyArray<{
    readonly environmentId: Id;
    readonly label: string;
    readonly state: DeviceServiceState;
  }>,
): DeviceToolSyncRow<Id>[] {
  const newest = environments
    .flatMap(({ state }) => (state.manifest ? [state.manifest] : []))
    .reduce<DeviceToolManifest | null>(
      (best, manifest) => (best === null || compareManifests(manifest, best) > 0 ? manifest : best),
      null,
    );
  return environments.flatMap(({ environmentId, label, state }) => {
    const olderRelease =
      newest !== null &&
      (state.manifest === undefined || compareManifests(state.manifest, newest) < 0);
    return state.hosts.map((host) => {
      const helperState = hostHelperState(host);
      return {
        key: deviceToolRowKey(environmentId, host.id),
        environmentId,
        environmentLabel: label,
        hostId: host.id,
        hostLabel: host.label,
        hostKind: host.kind,
        helperState,
        olderRelease,
        stale: host.toolInspectionError !== undefined,
        canUpdate: state.supportsEnvironmentToolSync === true && helperState === "behind",
        columns: hostToolColumns(host),
      };
    });
  });
}

/** Rows Update all should target: behind, updatable, and not already in flight. */
export function deviceToolUpdateTargets<Row extends DeviceToolSyncRow>(
  rows: ReadonlyArray<Row>,
  outcomes: ReadonlyMap<string, DeviceToolUpdateOutcome>,
): Row[] {
  return rows.filter((row) => row.canUpdate && outcomes.get(row.key)?.status !== "pending");
}

/** One line describing a fan-out across environments, or null before the first update. */
export function summarizeDeviceToolUpdates(
  outcomes: ReadonlyMap<string, DeviceToolUpdateOutcome>,
): string | null {
  let pending = 0;
  let succeeded = 0;
  let failed = 0;
  for (const outcome of outcomes.values()) {
    if (outcome.status === "pending") pending += 1;
    else if (outcome.status === "success") succeeded += 1;
    else failed += 1;
  }
  const total = pending + succeeded + failed;
  if (total === 0) return null;
  const hosts = (count: number) => `${count} ${count === 1 ? "host" : "hosts"}`;
  if (pending > 0) return `Updating ${hosts(pending)}… ${total - pending} of ${total} finished.`;
  if (failed === 0) return `Updated ${hosts(succeeded)}.`;
  if (succeeded === 0) return `Update failed on ${hosts(failed)}.`;
  return `Updated ${hosts(succeeded)}; ${failed} failed.`;
}

export type DeviceToolBanner =
  | {
      readonly kind: "behind";
      readonly hostIds: ReadonlyArray<string>;
      readonly message: string;
      readonly canUpdate: boolean;
    }
  | { readonly kind: "restart"; readonly message: string };

/** The Device panel's compact notice when this environment's helpers do not match its pins. */
export function deviceToolBanner(state: DeviceServiceState): DeviceToolBanner | null {
  const behind = state.hosts.filter((host) => hostHelperState(host) === "behind");
  if (behind.length > 0) {
    const pins = state.manifest
      ? ` Device Hub ${state.manifest.hub} and agent-device ${state.manifest.agent}`
      : " the pinned versions";
    const where =
      state.hosts.length > 1 ? ` on ${behind.map((host) => host.label).join(", ")}` : "";
    return {
      kind: "behind",
      hostIds: behind.map((host) => host.id),
      message: `Device tools${where} are behind this release. It pins${pins}.`,
      canUpdate: state.supportsEnvironmentToolSync === true,
    };
  }
  if (state.hosts.some((host) => hostHelperState(host) === "restart")) {
    return {
      kind: "restart",
      message:
        "Updated device tools are installed. Turn device support off and on in Settings after finishing active work to use them.",
    };
  }
  return null;
}
