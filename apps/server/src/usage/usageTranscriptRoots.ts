import * as NodeOS from "node:os";
import type * as Path from "effect/Path";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerSettings,
  type UsageProviderKind,
} from "@spiritdevs/contracts";

import { expandHomePath } from "../pathExpansion.ts";

/** Mirror explicit instance precedence, including credential-home overrides. */
export function usageTranscriptRoots(
  settings: ServerSettings,
  baseEnvironment: NodeJS.ProcessEnv,
  path: Path.Path,
) {
  const instances = { ...settings.providerInstances };
  for (const driver of ["codex", "claudeAgent"] as const) {
    if (!(driver in instances))
      instances[ProviderInstanceId.make(driver)] = {
        driver: ProviderDriverKind.make(driver),
        config: settings.providers[driver],
      };
  }
  const roots = new Map<string, { provider: UsageProviderKind; dir: string }>();
  for (const instance of Object.values(instances)) {
    if (
      instance.enabled === false ||
      (instance.driver !== "codex" && instance.driver !== "claudeAgent")
    )
      continue;
    const env = { ...baseEnvironment };
    for (const variable of instance.environment ?? []) env[variable.name] = variable.value;
    const home = env.HOME?.trim() || NodeOS.homedir();
    const config =
      typeof instance.config === "object" && instance.config !== null
        ? (instance.config as Record<string, unknown>)
        : {};
    const configured =
      typeof config.homePath === "string" && config.homePath.trim()
        ? config.homePath.trim()
        : undefined;
    const hasShadow =
      instance.driver === "codex" &&
      typeof config.shadowHomePath === "string" &&
      config.shadowHomePath.trim().length > 0;
    const environmentHome =
      (instance.driver === "codex" ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR)?.trim() || undefined;
    const raw =
      (configured ? expandHomePath(configured) : undefined) ??
      (hasShadow ? path.join(NodeOS.homedir(), ".codex") : environmentHome) ??
      path.join(home, instance.driver === "codex" ? ".codex" : ".claude");
    const resolved = path.resolve(
      raw === "~" ? home : raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw,
    );
    const provider = instance.driver === "codex" ? "codex" : "claude";
    for (const subdir of provider === "codex" ? ["sessions", "archived_sessions"] : ["projects"]) {
      const dir = path.join(resolved, subdir);
      roots.set(`${provider}:${dir}`, { provider, dir });
    }
  }
  return [...roots.values()];
}
