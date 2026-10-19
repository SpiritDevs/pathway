import type { ComputerControlMode } from "@spiritdevs/contracts";

export const COMPUTER_USE_SLASH_COMMAND = "computer-use";

/** Only a command at the start of the user's message is an invocation. */
export function parseComputerInvocation(text: string | undefined): { prompt: string } | null {
  if (!text) return null;
  // Four spaces or a tab are Markdown code indentation, not a command. Quotes,
  // fenced code, attachment blocks and mentions elsewhere never match.
  const match = /^ {0,3}\/computer-use(?:[ \t\r\n]+([\s\S]*))?$/i.exec(text);
  return match ? { prompt: (match[1] ?? "").trim() } : null;
}

/**
 * Frozen queue metadata wins over text; new turns resolve only their own text.
 * Only a user grants Computer, by the chat switch or a `/computer-use` turn:
 * agent and automation messages resolve to off whatever they carry.
 */
export function resolveComputerInvocationMode(input: {
  readonly messageText?: string | undefined;
  readonly dispatchOrigin?: string | undefined;
  readonly enableComputerControl?: boolean | undefined;
  readonly computerControlMode?: ComputerControlMode | undefined;
}): ComputerControlMode {
  if (input.computerControlMode !== undefined) return input.computerControlMode;
  const userAuthored = input.dispatchOrigin === undefined || input.dispatchOrigin === "user";
  if (!userAuthored) return "off";
  if (input.enableComputerControl === true) return "chat";
  return parseComputerInvocation(input.messageText) ? "request" : "off";
}
