/**
 * WebSocket handlers for the computer RPC group.
 *
 * Transport scopes admit a call before it gets here. These handlers add the
 * environment's Computer access policy (ADR 0041) on every way in — enabling
 * control, setup and input — and leave watching and Stop open to anyone the
 * transport admitted. `computer.subscribeEvents` is a stream RPC wired in
 * `ws.ts`, beside the per-connection event interests.
 *
 * @module computer/wsComputerHandlers
 */
import {
  COMPUTER_WS_METHODS,
  type ComputerActionResult,
  type ComputerClickInput,
  type ComputerControlEnabledResult,
  type ComputerDoubleClickInput,
  type ComputerDragInput,
  ComputerError,
  type ComputerGetAuditHistoryInput,
  type ComputerGetAuditHistoryResult,
  type ComputerGetScreenSizeInput,
  type ComputerGetScreenSizeResult,
  type ComputerGetStateInput,
  type ComputerGetStatusInput,
  type ComputerHotkeyInput,
  type ComputerInputClickInput,
  type ComputerInputKeyInput,
  type ComputerInputScrollInput,
  type ComputerLaunchAppInput,
  type ComputerLaunchAppResult,
  type ComputerListWindowsInput,
  type ComputerListWindowsResult,
  type ComputerMoveCursorInput,
  type ComputerPerformActionInput,
  type ComputerPressKeyInput,
  type ComputerProvisionInput,
  type ComputerProvisionResult,
  type ComputerRightClickInput,
  type ComputerScrollInput,
  type ComputerSelectTextInput,
  type ComputerSetControlEnabledInput,
  type ComputerSetValueInput,
  type ComputerState,
  type ComputerStatusResult,
  type ComputerThreadInput,
  type ComputerTypeTextInput,
  type EnvironmentAuthorizationError,
  type ThreadComputerState,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";

import type { ComputerApprovalGateShape } from "./ComputerApprovalGate.ts";
import { NO_COMPUTER_CAPABILITIES } from "./ComputerBackend.ts";
import type { ComputerManager } from "./ComputerManager.ts";
import type { ComputerServiceShape } from "./Services/ComputerService.ts";

/**
 * Shown only when no computer service started at all, so it cannot name the
 * missing piece the way a live backend's `availability()` does — a backend that
 * exists always reports its own reason, and this is the case where there is no
 * backend to ask. It therefore names the requirement every tier shares rather
 * than any one tier's dependencies.
 */
const UNSUPPORTED_MESSAGE = "No computer backend is available on this server.";

export type WsComputerError = ComputerError | EnvironmentAuthorizationError;

type Handler<I, A> = (input: I) => Effect.Effect<A, WsComputerError>;

function unsupported<A>(): Effect.Effect<A, ComputerError> {
  return Effect.fail(new ComputerError({ message: UNSUPPORTED_MESSAGE }));
}

/** A typed failure becomes the RPC's `ComputerError`; defects stay defects. */
function attempt<A, E extends { readonly message: string }>(
  effect: Effect.Effect<A, E>,
  fallbackMessage: string,
): Effect.Effect<A, ComputerError> {
  return Effect.mapError(
    effect,
    (cause) => new ComputerError({ message: cause.message || fallbackMessage }),
  );
}

export interface WsComputerHandlers {
  readonly [COMPUTER_WS_METHODS.setControlEnabled]: Handler<
    ComputerSetControlEnabledInput,
    ComputerControlEnabledResult
  >;
  readonly [COMPUTER_WS_METHODS.getStatus]: Handler<ComputerGetStatusInput, ComputerStatusResult>;
  readonly [COMPUTER_WS_METHODS.getAuditHistory]: Handler<
    ComputerGetAuditHistoryInput,
    ComputerGetAuditHistoryResult
  >;
  readonly [COMPUTER_WS_METHODS.provision]: Handler<
    ComputerProvisionInput,
    ComputerProvisionResult
  >;
  readonly [COMPUTER_WS_METHODS.listWindows]: Handler<
    ComputerListWindowsInput,
    ComputerListWindowsResult
  >;
  readonly [COMPUTER_WS_METHODS.getState]: Handler<ComputerGetStateInput, ComputerState>;
  readonly [COMPUTER_WS_METHODS.getScreenSize]: Handler<
    ComputerGetScreenSizeInput,
    ComputerGetScreenSizeResult
  >;
  readonly [COMPUTER_WS_METHODS.launchApp]: Handler<
    ComputerLaunchAppInput,
    ComputerLaunchAppResult
  >;
  readonly [COMPUTER_WS_METHODS.click]: Handler<ComputerClickInput, ComputerActionResult>;
  readonly [COMPUTER_WS_METHODS.doubleClick]: Handler<
    ComputerDoubleClickInput,
    ComputerActionResult
  >;
  readonly [COMPUTER_WS_METHODS.rightClick]: Handler<ComputerRightClickInput, ComputerActionResult>;
  readonly [COMPUTER_WS_METHODS.moveCursor]: Handler<ComputerMoveCursorInput, ComputerActionResult>;
  readonly [COMPUTER_WS_METHODS.drag]: Handler<ComputerDragInput, ComputerActionResult>;
  readonly [COMPUTER_WS_METHODS.scroll]: Handler<ComputerScrollInput, ComputerActionResult>;
  readonly [COMPUTER_WS_METHODS.typeText]: Handler<ComputerTypeTextInput, ComputerActionResult>;
  readonly [COMPUTER_WS_METHODS.pressKey]: Handler<ComputerPressKeyInput, ComputerActionResult>;
  readonly [COMPUTER_WS_METHODS.hotkey]: Handler<ComputerHotkeyInput, ComputerActionResult>;
  readonly [COMPUTER_WS_METHODS.setValue]: Handler<ComputerSetValueInput, ComputerActionResult>;
  readonly [COMPUTER_WS_METHODS.performAction]: Handler<
    ComputerPerformActionInput,
    ComputerActionResult
  >;
  readonly [COMPUTER_WS_METHODS.selectText]: Handler<ComputerSelectTextInput, ComputerActionResult>;
  readonly [COMPUTER_WS_METHODS.getThreadState]: Handler<ComputerThreadInput, ThreadComputerState>;
  readonly [COMPUTER_WS_METHODS.inputClick]: Handler<ComputerInputClickInput, ComputerActionResult>;
  readonly [COMPUTER_WS_METHODS.inputScroll]: Handler<
    ComputerInputScrollInput,
    ComputerActionResult
  >;
  readonly [COMPUTER_WS_METHODS.inputKey]: Handler<ComputerInputKeyInput, ComputerActionResult>;
}

export interface WsComputerHandlerOptions {
  /** Withdraws a thread's open approval cards when its control is switched off. */
  readonly approvalGate?: Pick<ComputerApprovalGateShape, "cancelThread">;
  /**
   * The Computer access policy check, run before every restricted call.
   * Watching and Stop never run it. Omitted, nothing is restricted.
   */
  readonly admitComputerUse?: Effect.Effect<void, WsComputerError>;
}

export function makeWsComputerHandlers(
  computerService: ComputerServiceShape | undefined,
  options: WsComputerHandlerOptions = {},
): WsComputerHandlers {
  const handlers = makeUnrestrictedHandlers(computerService, options.approvalGate);
  return options.admitComputerUse
    ? restrictComputerUse(handlers, options.admitComputerUse)
    : handlers;
}

function makeUnrestrictedHandlers(
  computerService: ComputerServiceShape | undefined,
  approvalGate: Pick<ComputerApprovalGateShape, "cancelThread"> | undefined,
): WsComputerHandlers {
  if (!computerService?.supported) {
    const unsupportedStatus = {
      computerId: computerService?.manager.computerId ?? "desktop",
      availability: computerService?.availability ?? {
        kind: "backend-unavailable" as const,
        message: UNSUPPORTED_MESSAGE,
      },
      // Nothing supervises a backend that was never started, so the health
      // of one is permanently the boot-time verdict.
      health: {
        status: "unavailable" as const,
        consecutiveFailures: 0,
        reconnects: 0,
        captureAvailable: false,
      },
      // A backend that was never started can do nothing, and saying so is
      // what keeps the panel's badges and the tool descriptions from
      // advertising a desktop this host has not got.
      capabilities: NO_COMPUTER_CAPABILITIES,
    } satisfies ComputerStatusResult;
    const unsupportedState = (input: ComputerThreadInput) =>
      Effect.succeed({
        ...unsupportedStatus,
        threadId: input.threadId,
        version: 0,
        windows: [],
        screenSize: { width: 1, height: 1 },
        agentActive: false,
        controlledByOtherThread: false,
        lastError: null,
      } satisfies ThreadComputerState);
    return {
      [COMPUTER_WS_METHODS.setControlEnabled]: () => unsupported(),
      [COMPUTER_WS_METHODS.getStatus]: () => Effect.succeed(unsupportedStatus),
      [COMPUTER_WS_METHODS.getAuditHistory]: (input) =>
        computerService
          ? attempt(
              computerService.manager.getAuditHistory(input),
              "Failed to read Computer activity history",
            )
          : Effect.succeed({ entries: [], nextCursor: null, truncated: false, status: "disabled" }),
      [COMPUTER_WS_METHODS.provision]: () => unsupported(),
      [COMPUTER_WS_METHODS.listWindows]: () => unsupported(),
      [COMPUTER_WS_METHODS.getState]: () => unsupported(),
      [COMPUTER_WS_METHODS.getScreenSize]: () => unsupported(),
      [COMPUTER_WS_METHODS.launchApp]: () => unsupported(),
      [COMPUTER_WS_METHODS.click]: () => unsupported(),
      [COMPUTER_WS_METHODS.doubleClick]: () => unsupported(),
      [COMPUTER_WS_METHODS.rightClick]: () => unsupported(),
      [COMPUTER_WS_METHODS.moveCursor]: () => unsupported(),
      [COMPUTER_WS_METHODS.drag]: () => unsupported(),
      [COMPUTER_WS_METHODS.scroll]: () => unsupported(),
      [COMPUTER_WS_METHODS.typeText]: () => unsupported(),
      [COMPUTER_WS_METHODS.pressKey]: () => unsupported(),
      [COMPUTER_WS_METHODS.hotkey]: () => unsupported(),
      [COMPUTER_WS_METHODS.setValue]: () => unsupported(),
      [COMPUTER_WS_METHODS.performAction]: () => unsupported(),
      [COMPUTER_WS_METHODS.selectText]: () => unsupported(),
      [COMPUTER_WS_METHODS.getThreadState]: unsupportedState,
      [COMPUTER_WS_METHODS.inputClick]: () => unsupported(),
      [COMPUTER_WS_METHODS.inputScroll]: () => unsupported(),
      [COMPUTER_WS_METHODS.inputKey]: () => unsupported(),
    };
  }

  const manager = computerService.manager;
  return {
    [COMPUTER_WS_METHODS.setControlEnabled]: (input) =>
      attempt(
        Effect.gen(function* () {
          // Stop withdraws the thread's open approval cards before revoking, so
          // nothing answered after Stop can re-arm the desktop.
          if (!input.enabled && approvalGate) yield* approvalGate.cancelThread(input.threadId);
          return yield* manager.setControlEnabled(input.threadId, input.enabled);
        }),
        "Failed to change computer authority",
      ),
    [COMPUTER_WS_METHODS.getStatus]: () => manager.getStatus(),
    [COMPUTER_WS_METHODS.getAuditHistory]: (input) =>
      attempt(manager.getAuditHistory(input), "Failed to read Computer activity history"),
    [COMPUTER_WS_METHODS.provision]: () =>
      attempt(manager.provision(), "Failed to set up computer control"),
    [COMPUTER_WS_METHODS.listWindows]: () =>
      attempt(manager.listWindows(), "Failed to list computer windows"),
    [COMPUTER_WS_METHODS.getState]: (input) =>
      attempt(
        manager.getState({
          ...(input.includeScreenshot !== undefined
            ? { includeScreenshot: input.includeScreenshot }
            : {}),
          ...(input.includeText !== undefined ? { includeText: input.includeText } : {}),
          ...(input.windowId !== undefined ? { windowId: input.windowId } : {}),
        }),
        "Failed to read computer perception state",
      ),
    [COMPUTER_WS_METHODS.getScreenSize]: () =>
      attempt(manager.getScreenSize(), "Failed to read computer screen size"),
    [COMPUTER_WS_METHODS.launchApp]: (input) =>
      attempt(
        manager.launchApp(undefined, input.app, input.arguments ?? []),
        "Failed to launch computer application",
      ),
    [COMPUTER_WS_METHODS.click]: (input) =>
      attempt(manager.click(undefined, input), "Failed to click on computer"),
    [COMPUTER_WS_METHODS.doubleClick]: (input) =>
      attempt(manager.doubleClick(undefined, input), "Failed to double-click on computer"),
    [COMPUTER_WS_METHODS.rightClick]: (input) =>
      attempt(manager.rightClick(undefined, input), "Failed to right-click on computer"),
    [COMPUTER_WS_METHODS.moveCursor]: (input) =>
      attempt(manager.moveCursor(undefined, input), "Failed to move computer cursor"),
    [COMPUTER_WS_METHODS.drag]: (input) =>
      attempt(
        manager.drag(undefined, input.from, input.to, input.durationMs ?? 250),
        "Failed to drag on computer",
      ),
    [COMPUTER_WS_METHODS.scroll]: (input) =>
      attempt(
        manager.scroll(undefined, scrollTarget(input), input.deltaX, input.deltaY),
        "Failed to scroll on computer",
      ),
    [COMPUTER_WS_METHODS.typeText]: (input) =>
      attempt(manager.typeText(undefined, input.text), "Failed to type on computer"),
    [COMPUTER_WS_METHODS.pressKey]: (input) =>
      attempt(manager.pressKey(undefined, input.key), "Failed to press computer key"),
    [COMPUTER_WS_METHODS.hotkey]: (input) =>
      attempt(manager.hotkey(undefined, input.keys), "Failed to send computer hotkey"),
    [COMPUTER_WS_METHODS.setValue]: (input) =>
      attempt(manager.setValue(undefined, input, input.value), "Failed to set computer value"),
    [COMPUTER_WS_METHODS.performAction]: (input) =>
      attempt(
        manager.performAction(undefined, input, input.action),
        "Failed to perform computer action",
      ),
    [COMPUTER_WS_METHODS.selectText]: (input) =>
      attempt(
        manager.selectText(undefined, input, { start: input.start, length: input.length }),
        "Failed to select computer text",
      ),
    [COMPUTER_WS_METHODS.getThreadState]: (input) => manager.getThreadState(input.threadId),
    [COMPUTER_WS_METHODS.inputClick]: (input) =>
      attempt(userInputClick(manager, input), "Failed to click on computer"),
    [COMPUTER_WS_METHODS.inputScroll]: (input) =>
      attempt(
        manager.withUserPointTarget({ x: input.x, y: input.y }, (target) =>
          manager.scroll(undefined, target, input.deltaX, input.deltaY),
        ),
        "Failed to scroll on computer",
      ),
    [COMPUTER_WS_METHODS.inputKey]: (input) =>
      attempt(userInputKey(manager, input), "Failed to press computer key"),
  };
}

/**
 * Runs `admit` before every way in: enabling control, setup, and all input.
 * Watching and Stop (`setControlEnabled` with `enabled: false`) stay open.
 */
function restrictComputerUse(
  handlers: WsComputerHandlers,
  admit: Effect.Effect<void, WsComputerError>,
): WsComputerHandlers {
  const restricted =
    <I, A>(handler: Handler<I, A>): Handler<I, A> =>
    (input) =>
      Effect.andThen(admit, () => handler(input));
  const setControlEnabled = handlers[COMPUTER_WS_METHODS.setControlEnabled];
  return {
    ...handlers,
    [COMPUTER_WS_METHODS.setControlEnabled]: (input) =>
      input.enabled ? restricted(setControlEnabled)(input) : setControlEnabled(input),
    [COMPUTER_WS_METHODS.provision]: restricted(handlers[COMPUTER_WS_METHODS.provision]),
    [COMPUTER_WS_METHODS.launchApp]: restricted(handlers[COMPUTER_WS_METHODS.launchApp]),
    [COMPUTER_WS_METHODS.click]: restricted(handlers[COMPUTER_WS_METHODS.click]),
    [COMPUTER_WS_METHODS.doubleClick]: restricted(handlers[COMPUTER_WS_METHODS.doubleClick]),
    [COMPUTER_WS_METHODS.rightClick]: restricted(handlers[COMPUTER_WS_METHODS.rightClick]),
    [COMPUTER_WS_METHODS.moveCursor]: restricted(handlers[COMPUTER_WS_METHODS.moveCursor]),
    [COMPUTER_WS_METHODS.drag]: restricted(handlers[COMPUTER_WS_METHODS.drag]),
    [COMPUTER_WS_METHODS.scroll]: restricted(handlers[COMPUTER_WS_METHODS.scroll]),
    [COMPUTER_WS_METHODS.typeText]: restricted(handlers[COMPUTER_WS_METHODS.typeText]),
    [COMPUTER_WS_METHODS.pressKey]: restricted(handlers[COMPUTER_WS_METHODS.pressKey]),
    [COMPUTER_WS_METHODS.hotkey]: restricted(handlers[COMPUTER_WS_METHODS.hotkey]),
    [COMPUTER_WS_METHODS.setValue]: restricted(handlers[COMPUTER_WS_METHODS.setValue]),
    [COMPUTER_WS_METHODS.performAction]: restricted(handlers[COMPUTER_WS_METHODS.performAction]),
    [COMPUTER_WS_METHODS.selectText]: restricted(handlers[COMPUTER_WS_METHODS.selectText]),
    [COMPUTER_WS_METHODS.inputClick]: restricted(handlers[COMPUTER_WS_METHODS.inputClick]),
    [COMPUTER_WS_METHODS.inputScroll]: restricted(handlers[COMPUTER_WS_METHODS.inputScroll]),
    [COMPUTER_WS_METHODS.inputKey]: restricted(handlers[COMPUTER_WS_METHODS.inputKey]),
  };
}

/**
 * A pane click carries a resolved desktop point, so it goes straight to the
 * coordinate path of the manager — no AT-SPI tree read, no semantic matching.
 */
function userInputClick(manager: ComputerManager, input: ComputerInputClickInput) {
  return manager.withUserPointTarget({ x: input.x, y: input.y }, (target) => {
    if (input.button === "right") return manager.rightClick(undefined, target);
    return (input.clickCount ?? 1) >= 2
      ? manager.doubleClick(undefined, target)
      : manager.click(undefined, target);
  });
}

function userInputKey(manager: ComputerManager, input: ComputerInputKeyInput) {
  // A repeated modifier would be pressed twice and released twice, which reads
  // as a tap of that modifier on the way out of the chord.
  const modifiers = [...new Set(input.modifiers ?? [])];
  return modifiers.length === 0
    ? manager.pressKey(undefined, input.key)
    : manager.hotkey(undefined, [...modifiers, input.key]);
}

function scrollTarget(input: ComputerScrollInput) {
  const target = {
    ...(input.x !== undefined ? { x: input.x } : {}),
    ...(input.y !== undefined ? { y: input.y } : {}),
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(input.role !== undefined ? { role: input.role } : {}),
    ...(input.windowId !== undefined ? { windowId: input.windowId } : {}),
  };
  const hasTarget =
    target.x !== undefined ||
    target.y !== undefined ||
    target.label !== undefined ||
    target.role !== undefined ||
    target.windowId !== undefined;
  return hasTarget ? target : null;
}
