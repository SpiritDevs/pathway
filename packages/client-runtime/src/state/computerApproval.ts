import type { ProviderRequestKind } from "@spiritdevs/contracts";

/**
 * What a Computer approval card is asking for, recovered from the prompt the
 * server writes with `computerApprovalCardText`. The approval item carries no
 * structured scope, so this parser and that function must stay in step.
 *
 * - `task`: consent for Computer for the rest of this turn.
 * - `app`: consent to drive one more app in this turn.
 * - `call`: one supervised action; `args` are the display-safe call arguments
 *   (typed text withheld by the server), when they parse.
 */
export type ComputerApprovalPrompt =
  | { readonly scope: "task" }
  | { readonly scope: "app"; readonly app: string }
  | {
      readonly scope: "call";
      readonly toolName: string;
      readonly args: Readonly<Record<string, unknown>> | undefined;
    };

export const COMPUTER_TASK_APPROVAL_PROMPT = "Allow Computer for this task";
const APP_PROMPT = /^Allow Computer to use (?<app>.+) in this task$/s;
const CALL_PROMPT_PREFIX = "Computer action needs approval: ";

/** Reads a Computer approval prompt; null for anything else, including other request kinds. */
export function parseComputerApprovalPrompt(input: {
  readonly requestKind: ProviderRequestKind;
  readonly detail?: string | undefined;
}): ComputerApprovalPrompt | null {
  if (input.requestKind !== "computer") return null;
  const prompt = input.detail?.trim();
  if (!prompt) return null;
  if (prompt === COMPUTER_TASK_APPROVAL_PROMPT) return { scope: "task" };
  const app = APP_PROMPT.exec(prompt)?.groups?.app?.trim();
  if (app) return { scope: "app", app };
  if (!prompt.startsWith(CALL_PROMPT_PREFIX)) return null;
  const call = prompt.slice(CALL_PROMPT_PREFIX.length).trim();
  const space = call.indexOf(" ");
  const toolName = space === -1 ? call : call.slice(0, space);
  if (toolName.length === 0) return null;
  return {
    scope: "call",
    toolName,
    args: space === -1 ? undefined : parseArgs(call.slice(space + 1)),
  };
}

function parseArgs(text: string): Readonly<Record<string, unknown>> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : undefined;
  } catch {
    return undefined;
  }
}
