# Computer approval text

Computer approvals are owned by Pathway (ADR 0048), but two parts of the flow still depend on
plain text instead of structured fields. This page lists each dependency, what breaks when the text
changes, and the tests that pin it.

## 1. Codex's MCP elicitation prompt

**Where:** `codexMcpElicitationAction` in
`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`.

Before Codex runs an MCP tool, it sends an `mcpServer/elicitation/request` with
`_meta.codex_approval_kind: "mcp_tool_call"`. Pathway accepts the request for its own Computer
tools on a live admitted turn, because the Computer approval gate asks the user itself. Current
Codex builds omit `_meta.tool_name`. When it is missing, the tool name comes from the message
Codex generates, which must match this exactly:

```
/^Allow the pathway MCP server to run tool "([a-z_]+)"\?$/
```

`pathway` is `PATHWAY_MCP_SERVER_NAME`. Synara reads the same wording, with its own server name, in
`codexAppServerManager.ts`.

**If Codex changes the wording:** the regex stops matching and every Computer elicitation is
declined. This fails closed. Nothing runs without approval, but each Computer tool call fails
for Codex until the regex is updated. Codex builds that send `_meta.tool_name` are unaffected,
because that field wins over the message.

**Tests:** the `codexMcpElicitationAction` block in `CodexAdapterV2.test.ts`. Its literal
`it.each` table pins the exact prompt, the rejected variants (another server, another tool,
trailing text, different casing), and the `tool_name` override. The Computer elicitation stop
guard block replays the same literal message through a full Codex session.

The other providers carry the tool identity in structured fields, not prose:

- **Claude** pre-approves `mcp__pathway__*` in `allowedTools`.
- **OpenCode** names the permission `pathway_<tool>`, which is checked against its MCP status.
- **ACP (Grok, registry agents)** reads the tool call's `title` and `_meta.serverName` with the
  shared matcher in `computerToolPermission.ts`. The title is agent-reported, not model-written.
  If an ACP agent stops titling MCP calls `mcp__pathway__<tool>`, the call falls through to the
  ordinary approval policy (fail closed). `AcpAdapterV2.test.ts` pins the accepted and rejected
  titles.
- **Cursor** has no permission callback, so there is nothing to parse.

## 2. The Computer approval card line

**Where:** the server writes the line with `computerApprovalCardText` in
`apps/server/src/computer/computerApprovalRequester.ts`. It is stored as the approval item's
`prompt`. The item has no structured scope, so clients parse the line back:

- web: `parseComputerApprovalPrompt` in `packages/client-runtime/src/state/computerApproval.ts`,
  used by the composer approval panel and Computer tool presentation;
- iOS: `PathwayComputerApprovalPrompt` in
  `apps/pathway-ios/Pathway/shared/datalayer/PathwayComputer.swift`.

| Scope  | Line                                                                       |
| ------ | -------------------------------------------------------------------------- |
| `task` | `Allow Computer for this task`                                             |
| `app`  | `Allow Computer to use <app> in this task`                                 |
| `call` | `Computer action needs approval: <tool>`, then ` <JSON args>` when present |

An `app` prompt with no named app is written as the `task` line.

**If the server wording changes without the parsers:** clients no longer recognise the card as
a Computer approval. They fall back to the generic approval card, which loses the scope-specific
title and button labels ("Allow for this task", "Allow Safari for this task", "Approve once")
and the call's argument preview. Accepting or declining still works, because the answer is keyed
by request id, not by text. A client older than the server shows the generic card until it
updates.

**Tests:** these use the same literals on each side.

- Writer: `computerApprovalRequester.test.ts` (`task`, `app`, the unnamed-app fallback, and
  `call` with and without arguments), plus the end-to-end prompts in `computerMcpTools.test.ts`.
- Web parser: `packages/client-runtime/src/state/computerApproval.test.ts`.
- iOS parser: the approval prompt tests in `apps/pathway-ios/PathwayTests/PathwayComputerTests.swift`.

Change all three together. This is a recorded port deviation (P6 composer in
`computer-use-port-deviations.md`). Synara's approval activity carries structured
`approvalScope`, `toolName` and `toolParamsDisplay` fields, but Pathway's approval item has only
`requestKind` and `prompt`. Adding a structured scope to the approval item in
`packages/contracts` would remove this dependency.
