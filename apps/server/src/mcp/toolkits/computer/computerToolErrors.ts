/**
 * Failure payloads the desktop and browser Computer families share, so both
 * name the same codes and say the same words. `computerTools.ts` re-exports
 * them.
 *
 * @module mcp/toolkits/computer/computerToolErrors
 */
import type { ComputerAuditEffect } from "@spiritdevs/contracts";
import * as Schema from "effect/Schema";

import type { ComputerAuditEntry } from "../../../computer/computerAuditLog.ts";
import {
  ComputerBackendError,
  ComputerTargetError,
  type CuaActionError,
  isComputerLeaseError,
  isCuaActionError,
} from "../../../computer/computerErrors.ts";
import { ToolInputError } from "./toolInput.ts";

/** The MCP capability every Computer tool requires. */
export const COMPUTER_CONTROL_CAPABILITY = "computer" as const;

export const INPUT_PAUSE_REQUERY_HINT =
  "To resume, call computer_get_state with the paused window_id, or with include_screenshot: true when no window is named; never replay an uncertain action.";

/**
 * The refusal a gated call gets when nobody can approve it. Each family
 * serializes it its own way: the desktop family pretty-prints through
 * `mcpToolResultJson`, the browser family compact.
 */
export function computerApprovalRequiredError(name: string): {
  readonly code: "ComputerApprovalRequired";
  readonly message: string;
} {
  return {
    code: "ComputerApprovalRequired",
    message: `${name} requires explicit user approval, and this provider session has no approval gate. The action was refused before it ran.`,
  };
}

/**
 * The failure payload a typed driver refusal reports - `error` is the
 * refusal code, not a message, because the model branches on it.
 */
export function cuaActionErrorPayload(error: CuaActionError): {
  readonly error: string;
  readonly effect: string;
  readonly message: string;
  readonly retryAllowed: false;
  readonly diagnostics?: ComputerAuditEntry["diagnostics"];
  readonly layer?: ComputerAuditEntry["layer"];
  readonly wait_seconds?: number;
  readonly requery_hint?: string;
} {
  return {
    error: error.code,
    effect: error.effect,
    message: error.message,
    retryAllowed: false,
    ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
    ...(error.layer ? { layer: error.layer } : {}),
    ...(error.waitSeconds !== undefined ? { wait_seconds: error.waitSeconds } : {}),
    ...(error.code === "computer_input_paused" ? { requery_hint: INPUT_PAUSE_REQUERY_HINT } : {}),
  };
}

/** The effect/code pair a failed call reports - a typed refusal or a fault. */
export function computerAuditErrorOutcome(error: unknown): {
  readonly effect: ComputerAuditEffect;
  readonly code: string;
  readonly diagnostics?: ComputerAuditEntry["diagnostics"];
  readonly layer?: ComputerAuditEntry["layer"];
} {
  // A CuaActionError already carries the delivery taxonomy's verdict.
  if (isCuaActionError(error))
    return {
      effect: error.effect,
      code: error.code,
      ...(error.diagnostics ? { diagnostics: error.diagnostics } : {}),
      ...(error.layer ? { layer: error.layer } : {}),
    };
  if (Schema.is(ComputerTargetError)(error)) return { effect: "refused", code: error.code };
  if (isComputerLeaseError(error)) return { effect: "refused", code: error.code };
  if (Schema.is(ComputerBackendError)(error)) {
    return error.inputPause !== undefined
      ? { effect: "refused", code: "computer_input_paused", layer: "server-manager" }
      : { effect: "error", code: "computer_backend_error" };
  }
  if (Schema.is(ToolInputError)(error)) return { effect: "refused", code: "invalid_arguments" };
  return { effect: "error", code: "error" };
}
