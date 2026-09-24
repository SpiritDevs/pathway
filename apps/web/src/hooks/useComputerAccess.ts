import { useAtomValue } from "@effect/atom-react";
import type { AuthSessionState, EnvironmentId } from "@spiritdevs/contracts";
import type { UnifiedSettings } from "@spiritdevs/contracts/settings";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { isElectron } from "../env";
import { primarySessionStateAtom } from "../environments/primary/sessionState";
import { sessionCanUseComputer } from "../lib/computerAccess";
import { usePrimaryEnvironmentId } from "../state/environments";
import { environmentSession } from "../state/session";
import { useComputerSupport } from "./useComputerSupport";
import { useEnvironmentSettings } from "./useSettings";

const NO_SESSION_ATOM = Atom.make(AsyncResult.initial<AuthSessionState>()).pipe(
  Atom.withLabel("computer-access:no-session"),
);

const selectAccessPolicy = (settings: UnifiedSettings) => settings.computer.accessPolicy;
const selectComputerControlEnabled = (settings: UnifiedSettings) => settings.computerControlEnabled;

/**
 * Whether this client may use Computer on the environment: its access policy
 * admits this session's scopes. The desktop app owns its primary server
 * outright, so it never reads the session there.
 */
export function useCanUseComputer(environmentId: EnvironmentId | null): boolean {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const isPrimary = environmentId !== null && environmentId === primaryEnvironmentId;
  const owned = isPrimary && isElectron;
  const result = useAtomValue(
    environmentId === null || owned
      ? NO_SESSION_ATOM
      : isPrimary
        ? primarySessionStateAtom
        : environmentSession.sessionStateAtom(environmentId),
  );
  const policy = useEnvironmentSettings(environmentId, selectAccessPolicy);
  if (owned) return true;
  return sessionCanUseComputer(policy, Option.getOrNull(AsyncResult.value(result)));
}

/**
 * The device-wide Computer control setting as it applies to one environment:
 * on only where that environment can drive a desktop and this session may use
 * it there. Every send reads this, so an environment that would refuse
 * Computer never refuses ordinary messages. An explicit `/computer-use` is
 * not gated; the user asked for it, and a refusal is the right answer.
 */
export function useComputerControlSetting(environmentId: EnvironmentId | null): boolean {
  const enabled = useEnvironmentSettings(environmentId, selectComputerControlEnabled);
  const supported = useComputerSupport(environmentId);
  const allowed = useCanUseComputer(environmentId);
  return enabled && supported && allowed;
}
