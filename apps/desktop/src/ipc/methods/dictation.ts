import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  DictationCommand,
  DictationHistoryEntry,
  DictationState,
} from "@spiritdevs/contracts/dictation";
import {
  DesktopDictation,
  DesktopDictationError,
  dictationEffect,
} from "../../dictation/DesktopDictation.ts";
import * as channels from "../../dictation/channels.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

const trusted = Effect.fn("desktop.dictation.trustedSender")(function* (
  event: DesktopIpc.DesktopIpcInvokeEvent | undefined,
  mainOnly = false,
) {
  const dictation = yield* DesktopDictation;
  const main = yield* (yield* ElectronWindow.ElectronWindow).main;
  if (event && Option.isSome(main) && main.value.webContents.id === event.sender.id) {
    dictation.bindMain(main.value);
    return dictation;
  }
  if (event && !mainOnly && dictation.isOverlay(event.sender.id)) return dictation;
  return yield* new DesktopDictationError({ message: "Dictation request was rejected." });
});

export const getDictationState = DesktopIpc.makeIpcMethod({
  channel: channels.DICTATION_GET_STATE,
  payload: Schema.Void,
  result: DictationState,
  handler: Effect.fn("desktop.dictation.getState")(function* (_, event) {
    const dictation = yield* trusted(event);
    yield* dictationEffect(() => dictation.controller.initialize());
    return dictation.controller.getState();
  }),
});
export const executeDictation = DesktopIpc.makeIpcMethod({
  channel: channels.DICTATION_EXECUTE,
  payload: DictationCommand,
  result: DictationState,
  handler: Effect.fn("desktop.dictation.execute")(function* (command, event) {
    const mainOnly = !["start", "stop", "cancel", "dismiss", "copy", "open"].includes(command.type);
    const dictation = yield* trusted(event, mainOnly);
    return yield* dictationEffect(() => dictation.controller.execute(command));
  }),
});
export const listDictationHistory = DesktopIpc.makeIpcMethod({
  channel: channels.DICTATION_HISTORY,
  payload: Schema.Void,
  result: Schema.Array(DictationHistoryEntry),
  handler: Effect.fn("desktop.dictation.history")(function* (_, event) {
    const dictation = yield* trusted(event);
    return yield* dictationEffect(() => dictation.controller.listHistory());
  }),
});
