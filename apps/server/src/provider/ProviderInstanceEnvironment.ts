import type { ProviderInstanceEnvironment } from "@spiritdevs/contracts";

/**
 * Computer host authority the server holds for itself. A provider child that
 * inherited these could reach the desktop host directly, around Pathway's
 * approvals, so they never cross into a provider's environment.
 */
const isComputerHostKey = (key: string) =>
  key.startsWith("PATHWAY_BROWSER_HOST_CAPABILITY") || key.startsWith("PATHWAY_CUA_");

/** The environment a provider child process starts with: the host's, plus the instance's own variables. */
export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!isComputerHostKey(key)) next[key] = value;
  }
  for (const variable of environment ?? []) {
    if (!isComputerHostKey(variable.name)) next[variable.name] = variable.value;
  }
  return next;
}
