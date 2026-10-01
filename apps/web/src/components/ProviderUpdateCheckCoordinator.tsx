import { useCallback, useEffect } from "react";

import { useEnvironments } from "../state/environments";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { isChildWindow } from "../panes/windowMode";

export function useCheckProviderUpdates() {
  const { environments } = useEnvironments();
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  return useCallback(async () => {
    const results = await Promise.all(
      environments
        .filter((environment) => environment.connection.phase === "connected")
        .map((environment) => refresh({ environmentId: environment.environmentId, input: {} })),
    );
    return {
      checked: results.filter((result) => result._tag === "Success").length,
      failed: results.filter((result) => result._tag === "Failure").length,
    };
  }, [environments, refresh]);
}

/** Native-menu and Settings update checks both reach this main-window listener. */
export function ProviderUpdateCheckCoordinator() {
  const check = useCheckProviderUpdates();
  useEffect(() => {
    if (isChildWindow) return;
    return window.desktopBridge?.onMenuAction?.((action) => {
      if (action === "check-provider-updates") void check();
    });
  }, [check]);
  return null;
}
