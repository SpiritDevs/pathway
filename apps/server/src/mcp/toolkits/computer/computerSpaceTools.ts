/**
 * `computer_spaces`: observe managed macOS Spaces and reserve an existing,
 * user-designated Space for the calling task. Discovery-only, reached through
 * computer_inspect and computer_help.
 *
 * @module mcp/toolkits/computer/computerSpaceTools
 */
import type { ComputerSpaceReservation } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";

import type { ComputerManager } from "../../../computer/ComputerManager.ts";
import { ComputerBackendError, ComputerSpaceError } from "../../../computer/computerErrors.ts";
import { assertDesktopOperationActive } from "../../../computer/DesktopOperationQueue.ts";
import { withModelDesktopObservation } from "../../../computer/modelDesktopObservation.ts";
import { COMPUTER_CONTROL_CAPABILITY } from "./computerToolErrors.ts";
import type { ComputerToolRun } from "./computerTools.ts";
import { ToolInputError } from "./toolInput.ts";
import type { ComputerToolError, ToolContext, ToolEntry, ToolHandler } from "./toolRuntime.ts";

interface SpaceToolsOptions {
  readonly manager: ComputerManager;
  readonly handle: (name: string, run: ComputerToolRun) => ToolHandler;
  readonly resolveSpaceDesignation?: (context: ToolContext) => Effect.Effect<readonly number[]>;
}

const invalidArgument = (message: string) => Effect.fail(new ToolInputError({ message }));

function spaceId(
  value: unknown,
  required: boolean,
): Effect.Effect<number | undefined, ToolInputError> {
  if (value === undefined && !required) return Effect.succeed(undefined);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    return invalidArgument(
      '"space_id" must be a positive safe integer from the current Space inventory.',
    );
  }
  return Effect.succeed(value);
}

/** The caller sees its selection, never another thread's identity. */
function publicReservation(value: ComputerSpaceReservation | null) {
  if (!value) return null;
  const { threadId: _threadId, turnId: _turnId, ...selection } = value;
  return selection;
}

/** A discoverable route through computer_inspect, with no added idle tool schema. */
export function makeComputerSpaceTools(options: SpaceToolsOptions): readonly ToolEntry[] {
  const broker = options.manager.spaceBroker;
  const designation = (context: ToolContext) =>
    options.resolveSpaceDesignation?.(context) ?? Effect.succeed<readonly number[]>([]);
  return [
    {
      requiredCapability: COMPUTER_CONTROL_CAPABILITY,
      requiresActiveTurn: true,
      discoveryOnly: true,
      definition: {
        name: "computer_spaces",
        description:
          "Observe managed macOS Spaces, including empty Spaces, or reserve an existing user-designated noncurrent Space for this task. Selection returns an exact window_id to drive in place; it never activates or moves anything. No native Space create/move/switch/follow is supported. Read computer_help topic spaces for designation and limits.",
        inputSchema: {
          type: "object",
          properties: {
            operation: {
              type: "string",
              description:
                "list (default), reserve, release, select, or peek. create, move, switch and follow return an explicit unsupported-operation refusal.",
            },
            space_id: {
              type: "number",
              description:
                "Exact current native Space ID; required for reserve, optional filter for list/peek. Do not use Mission Control position numbers.",
            },
            window_id: {
              type: "string",
              description:
                "Exact existing window in the reserved Space; required for select, optional with reserve or peek. Selection changes only the task's logical target.",
            },
          },
          additionalProperties: false,
        },
        annotations: {
          title: "Manage the task's desktop Space",
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      handler: options.handle(
        "computer_spaces",
        Effect.fnUntraced(function* (args, context) {
          for (const key of Object.keys(args)) {
            if (key !== "operation" && key !== "space_id" && key !== "window_id")
              return yield* invalidArgument(`Unknown argument "${key}".`);
          }
          const operation = args.operation ?? "list";
          if (typeof operation !== "string")
            return yield* invalidArgument('"operation" must be a string.');
          if (["create", "move", "switch", "follow"].includes(operation)) {
            return yield* new ComputerSpaceError(
              "computer_space_operation_unsupported",
              "This backend cannot create or switch managed Spaces, move windows between them, or follow a window by switching the user's desktop. Use an existing exact window in place. Nothing was moved or activated.",
            );
          }
          if (!["list", "reserve", "release", "select", "peek"].includes(operation))
            return yield* invalidArgument("Unknown Space operation.");
          const id = yield* spaceId(args.space_id, operation === "reserve");
          const windowId = args.window_id;
          if (
            windowId !== undefined &&
            (typeof windowId !== "string" || windowId.trim().length === 0 || windowId.length > 256)
          )
            return yield* invalidArgument('"window_id" must name an exact observed window.');
          if (operation === "select" && !windowId)
            return yield* invalidArgument('"select" requires "window_id".');
          const owner = { threadId: context.callerThreadId, turnId: context.callerTurnId };
          if (operation === "release") {
            if (id !== undefined || windowId !== undefined)
              return yield* invalidArgument(
                "Release acts only on this task's reservation and accepts no target.",
              );
            broker.release(owner.threadId, owner.turnId ?? undefined);
            return { operation, reservation: null, changedDesktop: false };
          }
          if (operation === "reserve") {
            const designated = yield* designation(context);
            yield* context.assertCallerTurnActive();
            yield* assertDesktopOperationActive;
            // The broker's recheck speaks desktop errors only; a turn that ended
            // during the read is latched here and surfaced as its own refusal.
            let turnEnded: ComputerToolError | undefined;
            const recheck = Effect.gen(function* () {
              const fresh = yield* designation(context);
              yield* context.assertCallerTurnActive();
              return fresh.includes(id!);
            }).pipe(
              Effect.mapError((error) => {
                turnEnded = error;
                return new ComputerBackendError({ message: error.message });
              }),
            );
            const reservation = yield* broker
              .reserve(owner, id!, designated, windowId, recheck)
              .pipe(Effect.mapError((error) => turnEnded ?? error));
            return {
              operation,
              reservation: publicReservation(reservation),
              changedDesktop: false,
            };
          }
          if (operation === "select") {
            if (id !== undefined)
              return yield* invalidArgument("Select uses this task's reservation; omit space_id.");
            return {
              operation,
              reservation: publicReservation(yield* broker.select(owner, windowId!)),
              changedDesktop: false,
            };
          }
          const snapshot = yield* broker.inspect(id);
          if (operation === "list" && windowId !== undefined)
            return yield* invalidArgument("Use peek to inspect one exact window.");
          const target =
            windowId === undefined
              ? undefined
              : snapshot.windows.find((window) => window.id === windowId);
          if (windowId !== undefined && !target)
            return yield* new ComputerSpaceError(
              "computer_space_target_outside_reservation",
              "That window is absent from this fresh Space inventory. List Spaces and windows again.",
            );
          const state = target
            ? yield* withModelDesktopObservation(
                options.manager.getState({
                  windowId: target.id,
                  includeScreenshot: false,
                  includeText: true,
                }),
              )
            : undefined;
          return {
            operation,
            ...snapshot,
            reservation: publicReservation(broker.reservationFor(owner)),
            ...(state ? { state } : {}),
            changedDesktop: false,
          };
        }),
      ),
    },
  ];
}
