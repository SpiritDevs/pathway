import * as Effect from "effect/Effect";
import { WorkflowRecordingAction } from "@spiritdevs/contracts";
import * as Schema from "effect/Schema";
import type { ComputerManager } from "../../../computer/ComputerManager.ts";
import { mcpToolResultJson, mcpToolResultError, type ToolEntry } from "./toolRuntime.ts";

const isAction = Schema.is(WorkflowRecordingAction);

/**
 * Record a skill for the calling thread. Discovery-only, so the advertised
 * catalog does not grow. The caller owns the recording; no model-supplied
 * thread or artifact path is accepted.
 */
export function makeWorkflowRecordingTools(manager: ComputerManager): readonly ToolEntry[] {
  return [
    {
      requiredCapability: "computer",
      requiresActiveTurn: true,
      discoveryOnly: true,
      definition: {
        name: "computer_recording",
        description:
          "Record a demonstration on the environment's Mac for a reusable skill. start asks the person there to confirm (nothing records before; max 30 minutes; your Computer input pauses until it ends). status reads this thread's recording. stop keeps it: its skillPrompt says how to write SKILL.md from metadataPath and eventsPath. cancel discards it and deletes the evidence.",
        inputSchema: {
          type: "object",
          properties: { action: { type: "string", enum: [...WorkflowRecordingAction.literals] } },
          required: ["action"],
          additionalProperties: false,
        },
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          const { action, ...rest } = args;
          if (!isAction(action) || Object.keys(rest).length !== 0)
            return mcpToolResultError(
              "Pass only action: status, start, stop, or cancel. The calling thread owns the recording.",
            );
          return mcpToolResultJson(yield* manager.recordWorkflow(action, context.callerThreadId));
        }).pipe(Effect.catch((error) => Effect.succeed(mcpToolResultError(error.message)))),
    },
  ];
}
