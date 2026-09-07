# Codex subagent status and usage

Subagent cards show completion when Codex reports that the child has finished, including when that report arrives through the parent conversation. Repeated completion reports preserve a recorded failure or interruption.

When Codex reports a subagent's model and reasoning effort, Pathway updates its configuration without changing the conversation title. Nested subagents use their immediate parent's configuration as the initial default. Unreported configuration is not treated as a confirmed model or effort in the subagent roster.

Reported token usage stays with a subagent across follow-ups. Repeated cumulative usage reports do not add the same tokens twice. The Agents panel shows an unknown total until every counted agent has reported usage.
