import { assert, describe, it } from "@effect/vitest";

import {
  CLAUDE_DELEGATION_GUARD_HOOKS,
  delegationGuardDenyReason,
  providerCliLaunchedByCommand,
} from "./ClaudeDelegationGuard.ts";

describe("providerCliLaunchedByCommand", () => {
  const launches: ReadonlyArray<readonly [string, string]> = [
    [
      `codex exec -m gpt-6.1-sol -c model_reasoning_effort=high -s workspace-write --cd "$PWD" "$(cat /tmp/fc-phaseA.md)" < /dev/null > /tmp/fc-phaseA.log 2>&1`,
      "codex",
    ],
    [`cd /repo && nohup codex -m gpt-6.1-sol exec "fix it" &`, "codex"],
    [
      `nohup zsh -c 'codex exec --cd /wt "$(cat p.md)" >> log 2>&1' > /dev/null 2>&1 < /dev/null &`,
      "codex",
    ],
    [`FOO=1 /opt/homebrew/bin/claude -p "review this"`, "claude"],
    [`echo prompt | claude --print --model opus`, "claude"],
    [`timeout 600 cursor-agent -p "do the thing"`, "cursor-agent"],
    [`opencode run "build it"`, "opencode"],
    [`out=$(grok --prompt "hi")`, "grok"],
  ];
  for (const [command, cli] of launches) {
    it(`detects ${cli} in ${command.slice(0, 40)}`, () => {
      assert.strictEqual(providerCliLaunchedByCommand(command), cli);
    });
  }

  const allowed = [
    "codex --version",
    "claude mcp list",
    "codex login status",
    `grep -rn "codex exec" docs`,
    `rg "claude -p" apps/server`,
    "cat apps/server/src/textGeneration/CodexTextGeneration.ts",
    "ls ~/.codex && opencode --help",
    "git commit -m 'grok -p support'",
  ];
  for (const command of allowed) {
    it(`allows ${command}`, () => {
      assert.isUndefined(providerCliLaunchedByCommand(command));
    });
  }
});

describe("CLAUDE_DELEGATION_GUARD_HOOKS", () => {
  const hook = CLAUDE_DELEGATION_GUARD_HOOKS.PreToolUse?.[0]?.hooks[0];
  const run = (command: string) =>
    hook!(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command, run_in_background: true },
        tool_use_id: "tool-1",
        session_id: "session-1",
        transcript_path: "/tmp/transcript.jsonl",
        cwd: "/repo",
      },
      "tool-1",
      { signal: new AbortController().signal },
    );

  it("denies Bash provider launches with a delegate_task redirect", async () => {
    assert.strictEqual(CLAUDE_DELEGATION_GUARD_HOOKS.PreToolUse?.[0]?.matcher, "Bash");
    assert.deepEqual(await run("codex exec 'build phase A' < /dev/null"), {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: delegationGuardDenyReason("codex"),
      },
    });
  });

  it("leaves other Bash commands alone", async () => {
    assert.deepEqual(await run("vp test run apps/server"), {});
  });
});
