import type { ScheduledTaskWebhookEndpoint } from "@spiritdevs/contracts";
import { isLoopbackHost } from "@spiritdevs/shared/preview";

/**
 * Where a sender can call a webhook task, as a client shows it. With a
 * Pathway Connect managed tunnel the server returns a public URL; without one
 * the path is resolved on the address this client reaches the environment at.
 */
export interface WebhookAddress {
  /** The URL to give a sender, or the bare path when no address is known. */
  readonly address: string;
  /** Whether `address` is a full URL a sender can call. */
  readonly copyable: boolean;
  /** One line on who can reach `address`; null for a Pathway Connect URL. */
  readonly note: string | null;
}

export function webhookAddress(
  endpoint: ScheduledTaskWebhookEndpoint,
  httpBaseUrl: string | null,
): WebhookAddress {
  if (endpoint.url !== null) {
    return { address: endpoint.url, copyable: true, note: null };
  }
  if (httpBaseUrl === null) {
    return {
      address: endpoint.path,
      copyable: false,
      note: "Turn on a Pathway Connect managed tunnel for a public URL.",
    };
  }
  const url = new URL(endpoint.path, httpBaseUrl);
  return {
    address: url.href,
    copyable: true,
    note: isLoopbackHost(url.hostname)
      ? "Only this computer can call this address. Turn on a Pathway Connect managed tunnel for a public URL."
      : "Works wherever this environment's address is reachable, for example over Tailscale or your own proxy. Turn on a Pathway Connect managed tunnel for a public URL.",
  };
}
