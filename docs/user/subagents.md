# Subagents

Agents can delegate work to subagents. Open a subagent's card in the conversation or its entry in Lineage to inspect the child conversation.

On web and desktop, each subagent in Lineage shows the icon of the provider it runs on, how long it has been working, and its status. Hover over a subagent to see its model and what it is doing right now. Finished subagents move into a collapsed Previous agents group below the ones still running.

On web and desktop, a subagent's conversation replaces the message box with a one-line bar. The bar shows the model and effort the subagent runs on, how long it has been working or took to finish, and an Open parent button that goes back to the conversation that started it. Subagents started through Pathway can still take messages: choose Message to open the full message box, where you can also change the model. Subagents a provider runs itself say Runs on its own and can't take messages. If a subagent is waiting on an approval or a question, the message box opens so you can answer.

A subagent started through Pathway gets the same access as the agent that started it. When that agent has full access, so do all of its subagents, so they don't stop for approvals you have already waived.

When a subagent stops to ask something, such as whether it may change a file outside the scope it was given, the question goes to the agent that started it. That agent answers when the decision is part of the work it handed off, and the subagent carries on. When the question needs your judgement, the agent asks you and passes your answer back. You can still answer a subagent's question yourself in its conversation.

Codex task names appear as readable labels. For example, `audit_server` appears as "Audit server" in the conversation, Lineage, and the child conversation's title. Nested subagents use their own task name; their relationship to the parent remains in Lineage. Previously saved conversations retain their saved titles.

Only subagents started through Pathway appear in Lineage. If an agent starts another provider's command-line tool itself, for example running `codex exec` in a terminal command, that work shows only as background work, without a provider, model, or child conversation. Claude agents can't do this in Pathway: the command is blocked and the agent is told to delegate the work as a subagent instead. If you have a project note or memory telling an agent to run `codex exec` or `claude -p`, update it to ask for a subagent.

## Work on another machine

An agent can also start work on another of your machines. For example, you can ask an agent on your laptop to investigate something on your desktop. The agent sees which machines and projects you can use, and starts a conversation in the project you choose, acting as you. That conversation runs on the other machine, and the agent can read it and send it messages. It is listed in the Lineage section of the agent's conversation rather than in your threads list, and its own Lineage links back to the agent's conversation.

This needs a recent Pathway on both machines. Your role must also allow you to dispatch and control remote agents. If the other machine runs an older Pathway, the agent tells you to update it first.
