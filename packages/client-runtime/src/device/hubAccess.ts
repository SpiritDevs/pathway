// @effect-diagnostics globalDate:off - Media URLs are checked outside an Effect runtime, like the live stream.
/** Credentials for media requests that cannot set bearer or DPoP headers. */
export interface DeviceHubAccess {
  /** Absolute environment URL ending in `/api/device-hub`. */
  readonly httpBase: string;
  /** Same base with the `ws(s)` scheme. */
  readonly wsBase: string;
  /** Empty for cookie sessions; includes a short-lived ticket for bearer and DPoP sessions. */
  readonly query: Readonly<Record<string, string>>;
  /** Whether requests must include session cookies. */
  readonly credentials: boolean;
  /** Epoch ms when the ticket in `query` expires; null for cookie sessions. */
  readonly expiresAt: number | null;
}

/** Whether a rejected upgrade can be blamed on an expired ticket rather than the route. */
export const deviceHubTicketExpired = (access: DeviceHubAccess, now = Date.now()): boolean =>
  access.expiresAt !== null && now >= access.expiresAt;

export const withDeviceHubQuery = (url: string, access: DeviceHubAccess): string => {
  const entries = Object.entries(access.query);
  if (entries.length === 0) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${new URLSearchParams(entries).toString()}`;
};

/** A fixed access, or a getter the owner updates as tickets rotate. */
export type DeviceHubAccessSource = DeviceHubAccess | (() => DeviceHubAccess);

export const currentDeviceHubAccess = (source: DeviceHubAccessSource): DeviceHubAccess =>
  typeof source === "function" ? source() : source;

/** Renewing a lease keeps its generation. Reconnect input sockets after acquisition. */
export function withDeviceControl(
  access: DeviceHubAccess,
  proof: import("@spiritdevs/contracts").DeviceControlProof | null,
): DeviceHubAccess {
  const { viewerId: _viewerId, controlGeneration: _generation, ...query } = access.query;
  return {
    ...access,
    query: proof
      ? { ...query, viewerId: proof.viewerId, controlGeneration: String(proof.generation) }
      : query,
  };
}
