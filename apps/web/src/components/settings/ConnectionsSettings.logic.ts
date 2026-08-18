import type { AdvertisedEndpoint, DesktopBridge, DesktopWslState } from "@spiritdevs/contracts";

const ACTIVE_ENVIRONMENT_CONNECTION_PHASES = new Set(["connected", "connecting", "reconnecting"]);

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
    (ACTIVE_ENVIRONMENT_CONNECTION_PHASES.has(environment.connection.phase)
      ? connected
      : disconnected
    ).push(environment);
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
