import type { ProviderInstanceEnvironment } from "@spiritdevs/contracts";
import { HostProcessEnvironment } from "@spiritdevs/shared/hostProcess";
import * as Effect from "effect/Effect";

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

/**
 * The `env`/`extendEnv` options to spawn a provider child with. `env` resolves
 * the way the Effect spawner resolves it (`extendEnv`, or no `env`, lays it
 * over the host environment), then loses the Computer host keys. The result
 * never extends: with `extendEnv: true` the spawner would merge `process.env`
 * back in and restore what was stripped.
 */
export const providerChildEnvironment = (
  options: {
    readonly env?: NodeJS.ProcessEnv | undefined;
    readonly extendEnv?: boolean | undefined;
  } = {},
) =>
  Effect.map(HostProcessEnvironment, (hostEnvironment) => {
    const env =
      options.env === undefined || options.extendEnv === true
        ? { ...hostEnvironment, ...options.env }
        : options.env;
    return { env: mergeProviderInstanceEnvironment(undefined, env), extendEnv: false as const };
  });
