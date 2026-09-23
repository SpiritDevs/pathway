import {
  COMPUTER_USE_SLASH_COMMAND,
  parseComputerInvocation,
} from "@spiritdevs/shared/computerInvocation";
import { applyClaudePromptEffortPrefix } from "@spiritdevs/shared/model";

import type { ComposerSlashCommand } from "../../composer-logic";

export interface BuiltInSlashCommandItem {
  readonly id: string;
  readonly type: "slash-command";
  readonly command: ComposerSlashCommand;
  readonly label: string;
  readonly description: string;
}

/** Pathway-owned slash commands, in menu order. */
export function buildBuiltInSlashCommandItems(input: {
  /** Whether this environment's server could ever drive a desktop. */
  readonly computerUseAvailable: boolean;
}): BuiltInSlashCommandItem[] {
  return [
    {
      id: "slash:model",
      type: "slash-command",
      command: "model",
      label: "/model",
      description: "Switch response model for this thread",
    },
    {
      id: "slash:plan",
      type: "slash-command",
      command: "plan",
      label: "/plan",
      description: "Switch this thread into plan mode",
    },
    {
      id: "slash:default",
      type: "slash-command",
      command: "default",
      label: "/default",
      description: "Switch this thread back to normal build mode",
    },
    ...(input.computerUseAvailable
      ? [
          {
            id: "slash:computer-use",
            type: "slash-command" as const,
            command: "computer-use" as const,
            label: "/computer-use",
            description: "Use Pathway Computer for this request only",
          },
        ]
      : []),
  ];
}

/**
 * Whether a provider's own slash command is shadowed by a Pathway command.
 * `/computer-use` is always Pathway's: the server reads it from the message
 * text, so a provider command of that name could never run.
 */
export function shouldHideProviderNativeSlashCommand(name: string): boolean {
  return name.trim().replace(/^\//, "").toLowerCase() === COMPUTER_USE_SLASH_COMMAND;
}

/** A standalone `/computer-use` with no task, which has nothing to do yet. */
export function isBareComputerUseInvocation(text: string): boolean {
  return parseComputerInvocation(text.trim())?.prompt === "";
}

/**
 * Applies a prompt-injected effort (Claude's "Ultrathink:") inside a
 * `/computer-use` invocation, so the command stays first and still invokes.
 */
export function applyPromptEffortKeepingComputerUse(
  text: string,
  promptEffort: string | null | undefined,
): string {
  const invocation = promptEffort ? parseComputerInvocation(text) : null;
  if (invocation) {
    return `/${COMPUTER_USE_SLASH_COMMAND} ${applyClaudePromptEffortPrefix(invocation.prompt, promptEffort)}`;
  }
  return applyClaudePromptEffortPrefix(text, promptEffort);
}
