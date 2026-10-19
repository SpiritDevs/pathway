/**
 * The manual claude.com sign-in page hands the user one string shaped like
 * `<code>#<state>`. Every Claude Code login surface splits it on the `#`
 * before exchanging the code, and the token exchange rejects the combined
 * string outright, so Pathway has to split it the same way.
 */
export type ClaudeAuthorizationCodeResult =
  | { readonly ok: true; readonly code: string }
  | { readonly ok: false; readonly reason: string };

const CLAUDE_AUTHORIZATION_CODE_SEPARATOR = "#";

export function parseClaudeAuthorizationCode(
  input: string,
  expectedState: string,
): ClaudeAuthorizationCodeResult {
  const value = input.trim();
  if (!value) {
    return { ok: false, reason: "Enter the authorization code from Claude." };
  }
  const separator = value.indexOf(CLAUDE_AUTHORIZATION_CODE_SEPARATOR);
  if (separator === -1) {
    return { ok: true, code: value };
  }
  const code = value.slice(0, separator).trim();
  const state = value.slice(separator + 1).trim();
  if (!code) {
    return {
      ok: false,
      reason: "Invalid authorization code. Make sure the full code was copied.",
    };
  }
  if (state && state !== expectedState) {
    return {
      ok: false,
      reason:
        "This code belongs to a different Claude sign-in. Open the Claude sign-in link again and paste the new code.",
    };
  }
  return { ok: true, code };
}
