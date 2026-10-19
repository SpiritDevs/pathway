/**
 * The shapes every Computer tool shares: the caller context a handler reads,
 * the catalog entry the MCP server registers, and the result helpers.
 *
 * Computer tools keep hand-written JSON schemas and return raw MCP results
 * (image parts included), so they sit beside the `effect/unstable/ai`
 * toolkits rather than inside one.
 *
 * @module mcp/toolkits/computer/toolRuntime
 */
import type { ProviderDriverKind } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type {
  ComputerApprovalError,
  ComputerApprovalOutcome,
} from "../../../computer/ComputerApprovalGate.ts";
import type { McpCapability } from "../../McpInvocationContext.ts";

export const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

export const WRITE_TOOL_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
} as const;

export type JsonRpcId = string | number | null;

/**
 * MCP `_meta` on a tool definition: namespaced hints a client may honour.
 *
 * - `anthropic/alwaysLoad`: the Claude Code harness includes this tool's schema
 *   in the prompt instead of deferring it behind tool search.
 * - `anthropic/searchHint`: replaces the description the same harness indexes
 *   for a deferred tool.
 */
export interface McpToolMeta {
  readonly "anthropic/alwaysLoad"?: boolean;
  readonly "anthropic/searchHint"?: string;
}

export interface McpToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly annotations?: {
    readonly title?: string;
    readonly readOnlyHint?: boolean;
    readonly destructiveHint?: boolean;
    readonly idempotentHint?: boolean;
    readonly openWorldHint?: boolean;
  };
  readonly _meta?: McpToolMeta;
}

export interface McpToolCallResult {
  readonly content: ReadonlyArray<
    | { readonly type: "text"; readonly text: string }
    | { readonly type: "image"; readonly data: string; readonly mimeType: string }
  >;
  readonly isError?: boolean;
  readonly structuredContent?: Record<string, unknown>;
}

export function mcpToolResultError(text: string): McpToolCallResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function mcpToolResultJson(value: unknown): McpToolCallResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

/** The calling agent, as every Computer tool handler sees it. */
export interface ToolContext {
  readonly callerThreadId: string;
  /**
   * The caller thread as a human would name it, for surfaces the human sees -
   * today the agent cursor's badge on the desktop. Null when the thread has no
   * title yet: the surface falls back to a generic label rather than an id.
   */
  readonly callerThreadLabel: string | null;
  /** The MCP provider session the call arrived on. */
  readonly callerSessionKey: string;
  readonly callerProvider: ProviderDriverKind;
  readonly callerCapabilities: ReadonlySet<McpCapability>;
  /** The active run of the caller thread, or null when none is running. */
  readonly callerTurnId: string | null;
  /** Fails when the turn the call belongs to is no longer the active one. */
  readonly assertCallerTurnActive: () => Effect.Effect<void, ComputerToolError>;
  readonly jsonRpcRequestId: JsonRpcId;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext,
) => Effect.Effect<McpToolCallResult>;

export interface ToolEntry {
  readonly definition: McpToolDefinition;
  readonly handler: ToolHandler;
  readonly requiredCapability: McpCapability;
  readonly requiresActiveTurn?: boolean;
  /**
   * Callable by exact name but withheld from `tools/list`: the advertised
   * catalog stays small while a tool the model already knows - or finds
   * through computer_help - still dispatches. Discovery-only is not a
   * permission: capability checks, approval and audit all apply unchanged.
   */
  readonly discoveryOnly?: boolean;
}

/**
 * Asks the user, as the environment's autonomy requires, before a gated call
 * runs. `"pending"` means the bounded wait expired with the card still open.
 */
export type ComputerAuthorizeAction = (
  name: string,
  args: Record<string, unknown>,
  context: ToolContext,
) => Effect.Effect<ComputerApprovalOutcome, ComputerApprovalError>;

/** A tool-level refusal the agent reads as a structured error result. */
export class ComputerToolError extends Schema.TaggedErrorClass<ComputerToolError>()(
  "ComputerToolError",
  {
    code: Schema.String,
    message: Schema.String,
    details: Schema.optional(Schema.Unknown),
  },
) {}

export function computerToolErrorResult(error: ComputerToolError): McpToolCallResult {
  return {
    ...mcpToolResultJson({
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
      },
    }),
    isError: true as const,
  };
}
