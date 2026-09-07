import type { EmailSearch } from "./emailView.logic";

/** Existing captured-message links retain their meaning when connected mail becomes the default. */
export function isCapturedEmailSearch(search: EmailSearch): boolean {
  if (search.source) return search.source === "capture";
  return Boolean(
    search.message ||
    search.inbox ||
    search.environment ||
    search.tag ||
    search.analytics ||
    search.tab,
  );
}

/** Relay mutations may confirm success without a JSON response body. */
export async function readMailRelayResponse(response: Response): Promise<unknown> {
  const raw = await response.text();
  let result: unknown = null;
  try {
    result = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(
      response.ok
        ? "The mail server returned an invalid response."
        : "Mail request failed. Please retry.",
    );
  }
  if (!response.ok) {
    const fields = result && typeof result === "object" ? result : null;
    const message =
      fields && "message" in fields && typeof fields.message === "string"
        ? fields.message
        : fields && "error" in fields && typeof fields.error === "string"
          ? fields.error
          : "Mail request failed. Please retry.";
    throw new Error(message);
  }
  return result;
}
