import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@spiritdevs/contracts";

/** Provider-visible name for Pathway's authenticated, app-owned MCP server. */
export const PATHWAY_MCP_SERVER_NAME = "pathway";

export const pathwayMcpToolName = (toolName: string): string =>
  `mcp__${PATHWAY_MCP_SERVER_NAME}__${toolName}`;

export const PATHWAY_MCP_TOOL_WILDCARD = pathwayMcpToolName("*");

/**
 * The per-call limit providers apply to Pathway tools. A Computer call can wait
 * five minutes for approval and then run up to 25 steps, so provider defaults
 * (Codex allows 60 s) would abandon calls Pathway is still completing.
 */
export const PATHWAY_MCP_TOOL_TIMEOUT_MS = 20 * 60_000;

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** The credential carries the `computer` toolkit. */
  readonly computerControl?: boolean;
}

const sessionsByThread = new Map<ThreadId, McpProviderSessionConfig>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  sessionsByThread.set(config.threadId, config);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  return sessionsByThread.get(threadId);
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
