import { Schema } from "effect";
import { MessageId, ThreadId } from "./baseSchemas.ts";
import { ChatImageAttachment } from "./chatAttachment.ts";
import {
  ComputerId,
  ComputerInputModifier,
  ComputerPoint,
  COMPUTER_TEXT_MAX_LENGTH,
} from "./computer.ts";

export const COMPUTER_SURFACE_METHODS = {
  getState: "computer.surface.getState",
  subscribe: "computer.surface.subscribe",
  takeControl: "computer.surface.takeControl",
  releaseControl: "computer.surface.releaseControl",
  input: "computer.surface.input",
  handBack: "computer.surface.handBack",
} as const;

export const ComputerSurfaceTarget = Schema.Struct({
  kind: Schema.Literal("computer"),
  computerId: ComputerId,
});
export type ComputerSurfaceTarget = typeof ComputerSurfaceTarget.Type;

export const ComputerSurfaceController = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("idle") }),
  Schema.Struct({ kind: Schema.Literal("agent"), threadId: ThreadId }),
  Schema.Struct({ kind: Schema.Literal("client"), clientId: Schema.String }),
]);
export type ComputerSurfaceController = typeof ComputerSurfaceController.Type;
export const ComputerSurfaceState = Schema.Struct({
  computerId: ComputerId,
  revision: Schema.Int,
  controller: ComputerSurfaceController,
  activeTurns: Schema.Array(Schema.Struct({ threadId: ThreadId, runId: Schema.String })),
  capabilities: Schema.Struct({
    capture: Schema.Boolean,
    input: Schema.Boolean,
    pointerPhases: Schema.Boolean,
  }),
});
export type ComputerSurfaceState = typeof ComputerSurfaceState.Type;
/** The server assigns one client id to each RPC connection. It cannot be claimed by another socket. */
export const ComputerSurfaceSessionState = Schema.Struct({
  clientId: Schema.String,
  state: ComputerSurfaceState,
});
export type ComputerSurfaceSessionState = typeof ComputerSurfaceSessionState.Type;

const Modifiers = Schema.optionalKey(
  Schema.Array(ComputerInputModifier).check(Schema.isMaxLength(4)),
);
const Button = Schema.Literals(["left", "right", "middle"]);
const Pointer = {
  ...ComputerPoint.fields,
  button: Schema.optionalKey(Button),
  modifiers: Modifiers,
};
const Delta = Schema.Finite.check(Schema.isBetween({ minimum: -10000, maximum: 10000 }));
/** Coordinates are primary-display desktop points, origin (0,0), never encoded-image pixels. */
export const ComputerSurfaceInput = Schema.Union([
  Schema.Struct({
    type: Schema.Literals(["pointer.move", "pointer.down", "pointer.up"]),
    ...Pointer,
  }),
  Schema.Struct({
    type: Schema.Literal("pointer.click"),
    ...Pointer,
    clickCount: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 }))),
  }),
  Schema.Struct({
    type: Schema.Literal("wheel"),
    ...ComputerPoint.fields,
    deltaX: Delta,
    deltaY: Delta,
    modifiers: Modifiers,
  }),
  Schema.Struct({
    type: Schema.Literal("key"),
    key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
    modifiers: Modifiers,
  }),
  Schema.Struct({
    type: Schema.Literal("type"),
    text: Schema.String.check(Schema.isMaxLength(COMPUTER_TEXT_MAX_LENGTH)),
  }),
]);
export type ComputerSurfaceInput = typeof ComputerSurfaceInput.Type;
export const ComputerSurfaceHandBackInput = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
});
export type ComputerSurfaceHandBackInput = typeof ComputerSurfaceHandBackInput.Type;
export const ComputerSurfaceHandBackResult = Schema.Struct({
  attachment: ChatImageAttachment,
  summary: Schema.String,
  state: ComputerSurfaceSessionState,
});
export type ComputerSurfaceHandBackResult = typeof ComputerSurfaceHandBackResult.Type;
