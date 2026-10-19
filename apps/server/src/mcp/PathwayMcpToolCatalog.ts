import * as Context from "effect/Context";
import { Tool } from "effect/unstable/ai";

import { EmailToolkit } from "./toolkits/email/tools.ts";
import { IssuesToolkit } from "./toolkits/issues/tools.ts";
import { OrchestratorToolkit } from "./toolkits/orchestrator/tools.ts";
import { PreviewToolkit } from "./toolkits/preview/tools.ts";
import { WorktreeToolkit } from "./toolkits/worktree/tools.ts";

/** The complete provider-facing tool catalog served by Pathway's production MCP endpoint. */
export const PATHWAY_MCP_TOOLS = [
  ...Object.values(PreviewToolkit.tools),
  ...Object.values(IssuesToolkit.tools),
  ...Object.values(OrchestratorToolkit.tools),
  ...Object.values(WorktreeToolkit.tools),
  ...Object.values(EmailToolkit.tools),
] as const;

export const PATHWAY_MCP_TOOL_NAMES = PATHWAY_MCP_TOOLS.map(({ name }) => name);

export const PATHWAY_READ_ONLY_MCP_TOOL_NAMES = PATHWAY_MCP_TOOLS.filter((tool) =>
  Context.get(tool.annotations, Tool.Readonly),
).map(({ name }) => name);
