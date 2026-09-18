export interface CliPublishOptions {
  readonly access: string;
  readonly tag: string;
  readonly provenance: boolean;
  readonly dryRun: boolean;
  readonly stage: boolean;
  readonly pack?: boolean;
  readonly packDestination?: string | undefined;
}

export function cliPublishOptionsIssue(config: CliPublishOptions) {
  if (config.pack && config.stage) return "--pack and --stage cannot be used together.";
  if (config.packDestination && !config.pack) return "--pack-destination requires --pack.";
  return undefined;
}

export function createCliPublishInvocation(config: CliPublishOptions) {
  if (config.pack) {
    const args = ["dlx", "npm@11.15.0", "pack", "--json", "--ignore-scripts"];
    if (config.dryRun) args.push("--dry-run");
    if (config.packDestination) args.push("--pack-destination", config.packDestination);
    return { command: "vp", args, cwd: "package" as const };
  }
  if (config.stage) {
    // npm owns staging. Packing is a local preparation check, not a registry
    // staging request, and cannot accidentally upload during --dry-run.
    const args = config.dryRun
      ? ["dlx", "npm@11.15.0", "pack", "--dry-run", "--json"]
      : ["dlx", "npm@11.15.0", "stage", "publish", "--access", config.access, "--tag", config.tag];
    return { command: "vp", args, cwd: "package" as const };
  }

  const args = [
    "pm",
    "publish",
    "--filter",
    "@spiritdevs/pathway",
    "--access",
    config.access,
    "--tag",
    config.tag,
    "--no-git-checks",
  ];
  if (config.provenance) args.push("--provenance");
  if (config.dryRun) args.push("--dry-run");
  return { command: "vp", args, cwd: "repository" as const };
}

export function publishedCliPlatforms() {
  return { os: ["darwin"], cpu: ["arm64"] };
}

export function publishedCliOverrides(npmPreparation: boolean, overrides: Record<string, string>) {
  // npm validates root overrides before packing. pnpm's `parent>child` and
  // removal selectors are invalid npm syntax; dependency packages' overrides
  // are not applied by consumers, so npm staging/packing omits this workspace policy.
  return npmPreparation ? {} : { overrides };
}
