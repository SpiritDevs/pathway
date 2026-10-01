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

/**
 * Pathway-owned tools, in menu order. They match the + menu's names; typing the
 * command after `/` still finds them.
 */
export function buildBuiltInSlashCommandItems(input: {
  /** Whether this environment's server could ever drive a desktop. */
  readonly computerUseAvailable: boolean;
}): BuiltInSlashCommandItem[] {
  return [
    {
      id: "slash:goal",
      type: "slash-command",
      command: "goal",
      label: "Goal",
      description: "Describe a goal and measurable outcomes",
    },
    {
      id: "slash:plan",
      type: "slash-command",
      command: "plan",
      label: "Plan mode",
      description: "Switch this thread into plan mode",
    },
    {
      id: "slash:default",
      type: "slash-command",
      command: "default",
      label: "Build mode",
      description: "Switch this thread back to normal build mode",
    },
    ...(input.computerUseAvailable
      ? [
          {
            id: "slash:computer-use",
            type: "slash-command" as const,
            command: "computer-use" as const,
            label: "Computer use",
            description: "Use Pathway Computer for this request only",
          },
        ]
      : []),
    {
      id: "slash:model",
      type: "slash-command",
      command: "model",
      label: "Model",
      description: "Switch response model for this thread",
    },
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
