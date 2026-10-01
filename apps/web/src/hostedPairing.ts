import { DEFAULT_HOSTED_APP_URL, NIGHTLY_HOSTED_APP_URL } from "@spiritdevs/shared/connectAuth";

import { getPairingTokenFromUrl, setPairingTokenOnUrl } from "./pairingUrl";

export interface HostedPairingRequest {
  readonly host: string;
  readonly token: string;
  readonly label: string;
}

export type HostedAppChannel = "latest" | "nightly";

export function configuredHostedAppUrl(): string {
  return import.meta.env.VITE_HOSTED_APP_URL?.trim() || DEFAULT_HOSTED_APP_URL;
}

export function buildHostedMailSetupUrl(): string {
  return new URL("/settings/email", configuredHostedAppUrl()).toString();
}

function configuredBackendUrl(): string {
  return import.meta.env.VITE_HTTP_URL?.trim() || import.meta.env.VITE_WS_URL?.trim() || "";
}

function configuredHostedAppChannel(): HostedAppChannel | null {
  const channel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();
  return channel === "latest" || channel === "nightly" ? channel : null;
}

function originFromUrl(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function isHostedStaticApp(url: URL = new URL(window.location.href)): boolean {
  if (configuredBackendUrl()) {
    return false;
  }

  if (configuredHostedAppChannel()) {
    return true;
  }

  const hostedOrigin = originFromUrl(configuredHostedAppUrl());
  return hostedOrigin !== null && url.origin === hostedOrigin;
}

const CLIENT_ONLY_STORAGE_KEY = "pathway:client-only";

/** Whether this browser chose to skip pairing with the server that serves it. */
export function isClientOnlyChosen(): boolean {
  try {
    return window.localStorage.getItem(CLIENT_ONLY_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** Remembers the pairing screen choice; callers reload so the connection layer follows it. */
export function setClientOnlyChosen(chosen: boolean): void {
  try {
    if (chosen) {
      window.localStorage.setItem(CLIENT_ONLY_STORAGE_KEY, "1");
    } else {
      window.localStorage.removeItem(CLIENT_ONLY_STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable in private modes; the choice then lasts only for this page.
  }
}

/** Undoes "Use as a client" and opens the pairing form for the server that serves this page. */
export function pairWithServingEnvironment(): void {
  setClientOnlyChosen(false);
  window.location.assign("/pair");
}

/**
 * True when the app only connects to saved environments: the hosted app, or a self-hosted
 * origin whose pairing screen was answered with "Use as a client".
 */
export function runsWithoutServingEnvironment(url: URL = new URL(window.location.href)): boolean {
  return isHostedStaticApp(url) || isClientOnlyChosen();
}

export function readHostedPairingRequest(url: URL = new URL(window.location.href)) {
  const host = url.searchParams.get("host")?.trim() ?? "";
  const token = getPairingTokenFromUrl(url)?.trim() ?? "";
  const label = url.searchParams.get("label")?.trim() ?? "";

  if (!host || !token) {
    return null;
  }

  return {
    host,
    token,
    label,
  } satisfies HostedPairingRequest;
}

export function hasHostedPairingRequest(url: URL = new URL(window.location.href)): boolean {
  return readHostedPairingRequest(url) !== null;
}

export function buildHostedPairingUrl(input: {
  readonly host: string;
  readonly token: string;
  readonly label?: string | null;
}): string {
  const url = new URL("/pair", configuredHostedAppUrl());
  url.searchParams.set("host", input.host);

  const label = input.label?.trim();
  if (label) {
    url.searchParams.set("label", label);
  }

  return setPairingTokenOnUrl(url, input.token).toString();
}

export function buildHostedChannelSelectionUrl(input: {
  readonly channel: HostedAppChannel;
}): string {
  return new URL(
    "/",
    input.channel === "nightly" ? NIGHTLY_HOSTED_APP_URL : DEFAULT_HOSTED_APP_URL,
  ).toString();
}
