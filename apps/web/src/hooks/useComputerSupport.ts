import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@spiritdevs/contracts";

import { useCachedComputerStatus } from "../computerStateStore";
import { serverEnvironment } from "../state/server";

/** The server platforms a computer backend exists for at all. */
const COMPUTER_CAPABLE_PLATFORMS: ReadonlySet<string> = new Set(["darwin", "linux"]);

/**
 * Whether the environment's server could ever drive a desktop. Support follows
 * the server's platform, not the browser's: a Mac browser connected to a
 * Windows server has no desktop to drive.
 *
 * Answered without asking the desktop, because `computer.getStatus` can start
 * the helper and raise a permission prompt. Uses the server platform, plus the
 * status only if another surface has already fetched it.
 */
export function useComputerSupport(environmentId: EnvironmentId | null): boolean {
  const capablePlatform = useComputerCapablePlatform(environmentId);
  const status = useCachedComputerStatus(environmentId);
  return capablePlatform && status?.availability.kind !== "unsupported-platform";
}

/**
 * Whether the environment's server platform has a computer backend at all.
 * False until the environment resolves, so nothing flickers in.
 */
export function useComputerCapablePlatform(environmentId: EnvironmentId | null): boolean {
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const platform = serverConfig?.environment.platform.os;
  return platform !== undefined && COMPUTER_CAPABLE_PLATFORMS.has(platform);
}
