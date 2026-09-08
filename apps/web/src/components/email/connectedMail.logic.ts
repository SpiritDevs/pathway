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
    if (!response.ok)
      throw new MailRelayError("Mail request failed. Please retry.", response.status);
    throw new Error("The mail server returned an invalid response.");
  }
  if (!response.ok) {
    const fields = result && typeof result === "object" ? result : null;
    const message =
      fields && "message" in fields && typeof fields.message === "string"
        ? fields.message
        : fields && "error" in fields && typeof fields.error === "string"
          ? fields.error
          : "Mail request failed. Please retry.";
    throw new MailRelayError(message, response.status);
  }
  return result;
}

class MailRelayError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function mailConnectionErrorMessage(error: unknown): string {
  if (error instanceof MailRelayError) {
    if (error.status === 404)
      return "Mail is not available on this Pathway Connect server yet. Ask your workspace administrator to update the mail service.";
    if (error.status === 503)
      return "Mail is not enabled on Pathway Connect. Ask your workspace administrator to finish email setup.";
  }
  return error instanceof MailRelayError
    ? error.message
    : "Mail service is unavailable. Check your connection and try again. If this continues, ask your workspace administrator to check Pathway Connect.";
}

export function gmailMessageUrl(accountEmail: string, providerMessageId: string): string {
  const url = new URL("https://mail.google.com/mail/u/");
  url.searchParams.set("authuser", accountEmail);
  url.hash = `all/${encodeURIComponent(providerMessageId)}`;
  return url.toString();
}

export function canDiscardMailDraft(status: string | undefined): boolean {
  return status === undefined || status === "draft" || status === "failed";
}
