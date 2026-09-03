import {
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
} from "@spiritdevs/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export const ALL_MCP_CAPABILITIES = ["preview", "orchestration", "worktree", "email"] as const;
export type McpCapability = (typeof ALL_MCP_CAPABILITIES)[number];

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** Local project owning the calling thread, used to resolve its company-scoped data. */
  readonly projectId?: ProjectId | undefined;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  /**
   * Which driver implements {@link providerInstanceId}. Carried alongside the routing key rather
   * than derived from it: `codex_personal` and `codex_work` are two instances of one driver, and
   * a tool that attributes a write to "the calling agent" means the driver, not the slug the user
   * happened to type in settings.
   */
  readonly providerDriverKind: ProviderDriverKind;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("@spiritdevs/pathway/mcp/McpInvocationContext") {}

export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: "preview",
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});
