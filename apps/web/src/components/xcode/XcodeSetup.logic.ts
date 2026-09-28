import type { ExecutionEnvironmentDescriptor } from "@spiritdevs/contracts";

/** Xcode needs a Mac; an environment without a descriptor has not told us yet. */
export function xcodeHostSupport(
  descriptor: Pick<ExecutionEnvironmentDescriptor, "platform"> | null,
): "mac" | "not-mac" | "unknown" {
  if (descriptor === null || descriptor.platform.os === "unknown") return "unknown";
  return descriptor.platform.os === "darwin" ? "mac" : "not-mac";
}

/** "MacBook Pro (studio.local)" from the privacy-safe device fields, when the host reports them. */
export function describeMac(
  descriptor: Pick<ExecutionEnvironmentDescriptor, "device"> | null,
): string | null {
  const device = descriptor?.device;
  if (!device) return null;
  if (device.model && device.hostname) return `${device.model} (${device.hostname})`;
  return device.model ?? device.hostname ?? null;
}

/** Keeps the remembered account while it still exists; otherwise the first one. */
export function pickXcodeAccountId(
  accounts: ReadonlyArray<{ readonly id: string }>,
  rememberedId: string | null,
): string | null {
  if (rememberedId !== null && accounts.some((account) => account.id === rememberedId)) {
    return rememberedId;
  }
  return accounts[0]?.id ?? null;
}

/**
 * Environment Xcode and Apple ID RPCs fail with XcodeError, AppleError or
 * EnvironmentAuthorizationError. All three carry a message that is safe to show.
 */
export function describeXcodeFailure(error: unknown, fallback: string): string {
  if (typeof error !== "object" || error === null || !("_tag" in error)) return fallback;
  const message = "message" in error && typeof error.message === "string" ? error.message : "";
  if (
    error._tag === "AppleError" &&
    "code" in error &&
    error.code === "rate-limited" &&
    "retryAfterSeconds" in error &&
    typeof error.retryAfterSeconds === "number"
  ) {
    return `Apple is rate limiting sign-in. Try again in ${Math.ceil(error.retryAfterSeconds)} seconds.`;
  }
  if (
    (error._tag === "XcodeError" ||
      error._tag === "AppleError" ||
      error._tag === "EnvironmentAuthorizationError") &&
    message.trim()
  ) {
    return message;
  }
  return fallback;
}

const REMEMBERED_ACCOUNT_KEY = "pathway:xcode:account:";

export function readRememberedXcodeAccount(environmentId: string): string | null {
  try {
    return window.localStorage.getItem(REMEMBERED_ACCOUNT_KEY + environmentId);
  } catch {
    return null;
  }
}

export function rememberXcodeAccount(environmentId: string, accountId: string): void {
  try {
    window.localStorage.setItem(REMEMBERED_ACCOUNT_KEY + environmentId, accountId);
  } catch {
    // Storage can be unavailable in private windows; the picker still works for this visit.
  }
}
