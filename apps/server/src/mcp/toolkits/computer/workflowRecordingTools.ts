import * as Effect from "effect/Effect";
import type { ComputerManager } from "../../../computer/ComputerManager.ts";
import {
  mcpToolResultJson,
  mcpToolResultError,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolEntry,
} from "./toolRuntime.ts";

/** The caller owns the recording; no model-supplied thread or artifact path is accepted. */
export function makeWorkflowRecordingTools(manager: ComputerManager): readonly ToolEntry[] {
  return (["status", "start", "stop", "cancel"] as const).map((action) => ({
    requiredCapability: "computer",
    requiresActiveTurn: action === "start",
    definition: {
      name: `computer_recording_${action}`,
      description: {
        status:
          "Read this thread's workflow recording status. Other threads' evidence is never returned.",
        start:
          "Ask the person on the environment's Mac to confirm recording a demonstration for a reusable skill. Nothing records until local consent; this records the environment, not your client's device. Maximum 30 minutes. Do not record sensitive tasks.",
        stop: "Stop this thread's demonstration and keep its local evidence. Use the completed metadataPath and eventsPath to create a reusable SKILL.md, with example values parameterized and private text removed. Skill creation alone does not prove successful replay.",
        cancel:
          "Cancel this thread's demonstration or discard its completed recording, deleting the local evidence.",
      }[action],
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations:
        action === "status"
          ? READ_ONLY_TOOL_ANNOTATIONS
          : {
              readOnlyHint: false,
              destructiveHint: action === "cancel",
              idempotentHint: true,
              openWorldHint: false,
            },
    },
    handler: (args, context) =>
      Effect.gen(function* () {
        if (Object.keys(args).length !== 0)
          return mcpToolResultError(
            "Recording tools accept no arguments; the calling thread owns the recording.",
          );
        if (action === "start") yield* context.assertCallerTurnActive();
        return mcpToolResultJson(yield* manager.recordWorkflow(action, context.callerThreadId));
      }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(error.message)))),
  }));
}
