const MAIL_RESPONSE_TIMEOUT_MS = 20_000;

/** Show a recoverable error if authentication or an unavailable mail service never answers. */
export function subscribeMailWithDeadline<Result>(
  subscribe: (receive: (value: Result) => void, reject: (error: Error) => void) => () => void,
  receive: (value: Result) => void,
  reject: (error: Error) => void,
) {
  let active = true;
  const timeout = setTimeout(() => {
    if (active)
      reject(
        new Error(
          "Mail did not respond. Check your connection and reload. If this continues, ask your workspace administrator to check the mail service.",
        ),
      );
  }, MAIL_RESPONSE_TIMEOUT_MS);
  let unsubscribe = () => {};
  try {
    unsubscribe = subscribe(
      (value) => {
        clearTimeout(timeout);
        if (active) receive(value);
      },
      (error) => {
        clearTimeout(timeout);
        if (active) reject(error);
      },
    );
  } catch (cause) {
    clearTimeout(timeout);
    reject(cause instanceof Error ? cause : new Error(String(cause)));
  }
  return () => {
    active = false;
    clearTimeout(timeout);
    unsubscribe();
  };
}

export function mailQueryErrorMessage(error: Error): string {
  return /Could not find public function|Function not found|not a registered function/i.test(
    error.message,
  )
    ? "Mail is not available in this workspace yet. Ask your workspace administrator to check the mail service."
    : error.message;
}
