import type {
  DeviceCheckRequirementsInput,
  DeviceCheckRequirementsResult,
  DeviceHostSummary,
  DeviceToolDrift,
  DeviceToolManifest,
} from "@spiritdevs/contracts";

/** Release-owned pins. Change this file when deliberately upgrading the device stack. */
export const DEVICE_TOOL_MANIFEST = {
  revision: "3",
  hub: "0.12.0-pathway.2",
  agent: "0.21.12",
  serveSim: "expo-device-hub@0.12.0-pathway.2",
  recommendedXcode: "26.0",
  recommendedRuntimes: [
    { platform: "ios", version: "26.0" },
    { platform: "android", version: "36" },
  ],
} as const satisfies DeviceToolManifest;

export function deviceToolDrift(host: DeviceHostSummary): ReadonlyArray<DeviceToolDrift> {
  const drift: DeviceToolDrift[] = [];
  const compare = (
    tool: DeviceToolDrift["tool"],
    expected: string,
    actual: ReadonlyArray<string> | undefined,
    running: string | null = null,
  ) => {
    drift.push({
      tool,
      expected,
      actual: actual ?? [],
      status:
        host.toolInspectionError || actual === undefined
          ? "unknown"
          : actual.includes(expected)
            ? "match"
            : actual.length
              ? "different"
              : "missing",
      restartRequired: running !== null && running !== expected,
    });
  };
  for (const tool of ["hub", "agent", "serveSim"] as const) {
    const version = host.tools?.[tool];
    compare(tool, DEVICE_TOOL_MANIFEST[tool], version?.installedVersions, version?.runningVersion);
  }
  const inventory = host.sdkInventory;
  compare(
    "xcode",
    DEVICE_TOOL_MANIFEST.recommendedXcode,
    !inventory || inventory.inspectionErrors.includes("xcode")
      ? undefined
      : inventory.xcode
        ? [inventory.xcode]
        : [],
  );
  for (const runtime of DEVICE_TOOL_MANIFEST.recommendedRuntimes) {
    compare(
      runtime.platform === "ios" ? "iosRuntime" : "androidRuntime",
      runtime.version,
      !inventory || inventory.inspectionErrors.includes(`${runtime.platform}:runtime`)
        ? undefined
        : inventory.runtimes
            .filter((value) => value.platform === runtime.platform)
            .map((value) => value.version),
    );
  }
  return drift;
}

/** Exact SDK/runtime availability, as resolved by the project's build integration. */
export function checkDeviceRequirements(
  host: DeviceHostSummary,
  input: DeviceCheckRequirementsInput,
): DeviceCheckRequirementsResult {
  const missing: DeviceCheckRequirementsResult["missing"][number][] = [];
  const unknown: DeviceCheckRequirementsResult["unknown"][number][] = [];
  for (const requirement of input.requirements) {
    const inventory = host.sdkInventory;
    if (
      !inventory ||
      host.toolInspectionError ||
      inventory.inspectionErrors.includes(`${requirement.platform}:${requirement.kind}`)
    ) {
      unknown.push(requirement);
      continue;
    }
    const candidates = requirement.kind === "sdk" ? inventory.sdks : inventory.runtimes;
    if (
      !candidates.some(
        (value) => value.platform === requirement.platform && value.version === requirement.version,
      )
    )
      missing.push(requirement);
  }
  return {
    hostId: host.id,
    satisfied: missing.length === 0 && unknown.length === 0,
    missing,
    unknown,
  };
}
