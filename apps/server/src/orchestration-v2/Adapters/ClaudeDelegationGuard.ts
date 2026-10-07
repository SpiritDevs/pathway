import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";

// Headless provider launches, keyed by binary. Each pattern runs against the
// arguments that follow the binary within one shell command segment.
const PROVIDER_CLI_LAUNCHES: ReadonlyArray<{ readonly cli: string; readonly args: RegExp }> = [
  { cli: "codex", args: /(?:^|\s)exec(?:\s|$)/ },
  { cli: "claude", args: /(?:^|\s)(?:-p|--print)(?:[\s=]|$)/ },
  { cli: "cursor-agent", args: /(?:^|\s)(?:-p|--print)(?:[\s=]|$)/ },
  { cli: "opencode", args: /(?:^|\s)run(?:\s|$)/ },
  { cli: "grok", args: /(?:^|\s)(?:-p|--prompt)(?:[\s=]|$)/ },
];

// A binary in command position: line start, after a separator, a subshell, or
// a shell `-c` string, past wrappers like `nohup`, `env`, or `VAR=value`.
const COMMAND_POSITION_LAUNCH =
  /(?:^|[\n;&|(`]|\$\(|-c\s+['"])\s*(?:(?:nohup|time|exec|command|env|caffeinate(?:\s+-\S+)*|timeout\s+\S+|[A-Za-z_][A-Za-z0-9_]*=\S*)\s+)*(?:\S*\/)?(codex|claude|cursor-agent|opencode|grok)(?=\s|$)([^\n;&|]*)/g;

/** Returns the provider CLI a shell command launches headlessly, if any. */
export function providerCliLaunchedByCommand(command: string): string | undefined {
  for (const match of command.matchAll(COMMAND_POSITION_LAUNCH)) {
    const [, cli, args = ""] = match;
    if (PROVIDER_CLI_LAUNCHES.some((launch) => launch.cli === cli && launch.args.test(args))) {
      return cli;
    }
  }
  return undefined;
}

export function delegationGuardDenyReason(cli: string): string {
  return `Pathway blocked this command: launching the \`${cli}\` CLI from a shell starts an agent Pathway cannot show as a subagent or attribute to a provider and model. Use the pathway \`delegate_task\` tool instead, with the provider and model in \`target\` (see \`orchestrator_capabilities\` for IDs).`;
}

/**
 * PreToolUse hooks for Claude sessions with the Pathway MCP attached: deny Bash
 * commands that launch a provider CLI so the agent retries with `delegate_task`.
 * Hooks run in every permission mode, including bypassPermissions.
 */
export const CLAUDE_DELEGATION_GUARD_HOOKS: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
  PreToolUse: [
    {
      matcher: "Bash",
      hooks: [
        async (input) => {
          if (input.hook_event_name !== "PreToolUse") return {};
          const toolInput = input.tool_input;
          const command =
            typeof toolInput === "object" && toolInput !== null && "command" in toolInput
              ? toolInput.command
              : undefined;
          const cli =
            typeof command === "string" ? providerCliLaunchedByCommand(command) : undefined;
          if (cli === undefined) return {};
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: delegationGuardDenyReason(cli),
            },
          };
        },
      ],
    },
  ],
};
