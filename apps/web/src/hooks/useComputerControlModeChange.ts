import { squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@spiritdevs/contracts";
import { useCallback, useEffect, useRef } from "react";

import { toastManager } from "../components/ui/toast";
import type { ComposerComputerControlMode } from "../computerControlMode";
import { computerEnvironment } from "../state/computer";
import { usePrimaryEnvironmentId } from "../state/environments";
import { useAtomCommand } from "../state/use-atom-command";
import {
  readLocalComputerPermissionBridge,
  runComputerControlModeChange,
} from "./useComputerControlModeChange.logic";

/** Explicit activation also enters the desktop's native permission guide. */
export function useComputerControlModeChange({
  threadRef,
  setMode,
  focusComposer,
}: {
  threadRef: ScopedThreadRef | null;
  setMode: (
    threadRef: ScopedThreadRef,
    mode: ComposerComputerControlMode,
    options: { readonly generation: number },
  ) => void;
  focusComposer: () => void;
}) {
  const setControlEnabled = useAtomCommand(computerEnvironment.setControlEnabled, {
    reportFailure: false,
  });
  // The desktop's own server is its primary environment.
  const localEnvironmentId = usePrimaryEnvironmentId();
  const sequence = useRef(0);
  const environmentId = threadRef?.environmentId ?? null;
  const threadId = threadRef?.threadId ?? null;
  useEffect(
    () => () => {
      sequence.current += 1;
    },
    [environmentId, threadId],
  );
  const change = useCallback(
    (mode: ComposerComputerControlMode) => {
      if (environmentId === null || threadId === null) return;
      const ref = { environmentId, threadId };
      const request = ++sequence.current;
      void runComputerControlModeChange(mode, {
        setControlEnabled: async (enabled) => {
          const result = await setControlEnabled({ environmentId, input: { threadId, enabled } });
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return result.value;
        },
        setMode: (nextMode, options) => setMode(ref, nextMode, options),
        permissionBridge: readLocalComputerPermissionBridge({
          environmentId,
          localEnvironmentId,
          bridge: window.desktopBridge?.computer,
        }),
        focusComposer,
        isCurrent: () => request === sequence.current,
        notify: (toast) => toastManager.add(toast),
      });
    },
    [environmentId, threadId, localEnvironmentId, setControlEnabled, setMode, focusComposer],
  );
  return { change, sequence };
}
