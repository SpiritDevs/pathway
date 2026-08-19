import type {
  AdvertisedEndpoint,
  DesktopBridge,
  DesktopWslState,
  EnvironmentId,
} from "@spiritdevs/contracts";

export function partitionEnvironmentsByConnection<
  T extends { readonly connection: { readonly phase: string } },
>(
  environments: ReadonlyArray<T>,
): {
  readonly connected: ReadonlyArray<T>;
  readonly disconnected: ReadonlyArray<T>;
} {
  const connected: Array<T> = [];
  const disconnected: Array<T> = [];

  for (const environment of environments) {
    (environment.connection.phase === "connected" ? connected : disconnected).push(environment);
  }

  return { connected, disconnected };
}

export function partitionClientSessionsByConnection<
  T extends { readonly connected: boolean; readonly current: boolean },
>(
  sessions: ReadonlyArray<T>,
): {
  readonly connected: ReadonlyArray<T>;
  readonly disconnected: ReadonlyArray<T>;
} {
  const connected: Array<T> = [];
  const disconnected: Array<T> = [];

  for (const session of sessions) {
    (session.current || session.connected ? connected : disconnected).push(session);
  }

  return { connected, disconnected };
}

/**
 * Environment rows are the canonical presentation for Pathway hosts. Their relay sessions stay
 * out of the client-only access list; if an environment is removed, its remaining session becomes
 * visible there again so access can still be reviewed and revoked.
 */
export function excludeRepresentedEnvironmentClientSessions<
  Session extends {
    readonly subject: string;
    readonly initiatingEnvironmentId?: EnvironmentId;
    readonly current: boolean;
    readonly client: { readonly deviceType: string; readonly browser?: string };
  },
  Environment extends { readonly environmentId: EnvironmentId },
>(
  sessions: ReadonlyArray<Session>,
  environments: ReadonlyArray<Environment>,
  hideCurrentDesktopSession = false,
): ReadonlyArray<Session> {
  const representedEnvironmentIds = new Set(environments.map(({ environmentId }) => environmentId));
  if (!hideCurrentDesktopSession && representedEnvironmentIds.size === 0) return sessions;
  return sessions.filter(
    ({ client, current, initiatingEnvironmentId, subject }) =>
      !(hideCurrentDesktopSession && current) &&
      !(
        hideCurrentDesktopSession &&
        initiatingEnvironmentId === undefined &&
        subject === "cloud-connect" &&
        client.deviceType === "desktop" &&
        client.browser === "Electron"
      ) &&
      (initiatingEnvironmentId === undefined ||
        !representedEnvironmentIds.has(initiatingEnvironmentId)),
  );
}

type WslEnableBridge = Pick<DesktopBridge, "setWslBackendEnabled" | "setWslDistro" | "setWslOnly">;

/**
 * A QR code encoding a loopback URL makes the scanning device dial itself, so
 * loopback endpoints stay copyable from the endpoint menu but are never
 * offered as QR targets.
 */
export function isQrShareableEndpoint(endpoint: AdvertisedEndpoint): boolean {
  return endpoint.status !== "unavailable" && endpoint.reachability !== "loopback";
}

export type QrEndpointOption = {
  /** Unique per endpoint instance (AdvertisedEndpoint.id); safe as a React key. */
  readonly id: string;
  /**
   * Stable per endpoint *type* (endpointDefaultPreferenceKey). Multiple
   * endpoints can share one, so it is only used to match the saved default.
   */
  readonly preferenceKey: string;
  /** False for endpoints that stay copyable but must never render as a QR. */
  readonly qrShareable: boolean;
};

/**
 * Resolves which endpoint the share panel shows: the user's explicit pick,
 * else the saved default endpoint, else the first QR-shareable option (so the
 * panel never opens on a loopback QR), else the first option. A stale
 * selectedId (endpoint disappeared) falls back rather than blanking the panel.
 */
export function selectQrEndpointOption<T extends QrEndpointOption>(
  options: ReadonlyArray<T>,
  selectedId: string | null,
  defaultPreferenceKey: string | null,
): T | null {
  return (
    (selectedId !== null ? options.find((option) => option.id === selectedId) : undefined) ??
    (defaultPreferenceKey !== null
      ? options.find((option) => option.preferenceKey === defaultPreferenceKey)
      : undefined) ??
    options.find((option) => option.qrShareable) ??
    options[0] ??
    null
  );
}

export async function applyWslEnableSelection(input: {
  readonly bridge: WslEnableBridge;
  readonly mode: "both" | "wsl-only";
  readonly nextDistro: string | null;
  readonly persistedDistro: string | null;
}): Promise<DesktopWslState> {
  const { bridge, mode, nextDistro, persistedDistro } = input;

  // Stage every preference before enabling. The desktop only relaunches for
  // mode/distro changes while WSL is active, so the final enable observes the
  // complete selection and is the only call that may relaunch.
  await bridge.setWslOnly(mode === "wsl-only");
  if (persistedDistro !== nextDistro) {
    await bridge.setWslDistro(nextDistro);
  }
  return await bridge.setWslBackendEnabled(true);
}
