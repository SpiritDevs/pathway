import {
  ComputerSetupRequiredPayload,
  type ComputerBuildSignature,
  type ComputerPermission,
  type OrchestrationV2TurnItem,
} from "@spiritdevs/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** `dynamic_tool` names the server's Computer toolkit posts its transcript notices under. */
export const COMPUTER_SETUP_REQUIRED_NOTICE_TOOL = "computer_setup_required";
export const COMPUTER_CONTROL_DENIED_NOTICE_TOOL = "computer_capability_denied";

/**
 * A Computer notice the transcript renders as an actionable card rather than
 * a tool row: the desktop needs setup, or the chat's Computer control is off.
 */
export type ComputerTranscriptNotice =
  | {
      readonly kind: "setup-required";
      /** Empty when the backend refused without naming a grant. */
      readonly missing: ReadonlyArray<ComputerPermission>;
      readonly buildSignature?: ComputerBuildSignature;
      readonly bundleId?: string;
    }
  | { readonly kind: "control-denied"; readonly toolName: string | null };

const decodeSetupPayload = Schema.decodeUnknownOption(ComputerSetupRequiredPayload);

/** The Computer notice an item carries, or null for every other item. */
export function computerNoticeOfTurnItem(
  item: Pick<OrchestrationV2TurnItem, "type"> & {
    readonly toolName?: string | null;
    readonly input?: unknown;
  },
): ComputerTranscriptNotice | null {
  if (item.type !== "dynamic_tool") return null;
  if (item.toolName === COMPUTER_SETUP_REQUIRED_NOTICE_TOOL) {
    // A payload that no longer decodes still means "needs setup"; the card
    // then says what it can without naming grants.
    const payload = Option.getOrNull(decodeSetupPayload(item.input));
    return {
      kind: "setup-required",
      missing: payload?.missing ?? [],
      ...(payload?.buildSignature === undefined ? {} : { buildSignature: payload.buildSignature }),
      ...(payload?.bundleId === undefined ? {} : { bundleId: payload.bundleId }),
    };
  }
  if (item.toolName === COMPUTER_CONTROL_DENIED_NOTICE_TOOL) {
    const toolName =
      item.input !== null && typeof item.input === "object" && "toolName" in item.input
        ? item.input.toolName
        : null;
    return {
      kind: "control-denied",
      toolName: typeof toolName === "string" && toolName.trim() ? toolName.trim() : null,
    };
  }
  return null;
}
