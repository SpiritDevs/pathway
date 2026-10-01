import {
  SIM_BUILD_LOG_WINDOW_CHARS,
  SIM_BUILD_WS_METHODS,
  type SimBuildJob,
  type SimBuildLogChunk,
  type SimBuildReceipt,
  type SimBuildUpdate,
} from "@spiritdevs/contracts/simBuild";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/unstable/reactivity";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export interface SimBuildView {
  readonly job: SimBuildJob | null;
  readonly receipts: readonly SimBuildReceipt[];
  readonly logs: readonly SimBuildLogChunk[];
  readonly nextLogSequence: number;
  readonly logsTruncated: boolean;
}
export const EMPTY_SIM_BUILD_VIEW: SimBuildView = {
  job: null,
  receipts: [],
  logs: [],
  nextLogSequence: 1,
  logsTruncated: false,
};
/** A reconnect snapshot replaces the old job window; sequence keys deduplicate replay. */
export function applySimBuildUpdate(previous: SimBuildView, update: SimBuildUpdate): SimBuildView {
  const base =
    update.kind === "snapshot" || previous.job?.id !== update.job.id
      ? EMPTY_SIM_BUILD_VIEW
      : previous;
  const logs = [...base.logs, ...update.logs.filter((log) => log.sequence >= base.nextLogSequence)];
  let size = logs.reduce((total, log) => total + log.text.length, 0);
  let truncated = base.logsTruncated || update.firstLogSequence > base.nextLogSequence;
  while (size > SIM_BUILD_LOG_WINDOW_CHARS || logs.length > 64) {
    size -= logs.shift()!.text.length;
    truncated = true;
  }
  const lastReceipt = base.receipts.at(-1)?.sequence ?? 0;
  return {
    job: update.job,
    receipts: [
      ...base.receipts,
      ...update.receipts.filter((receipt) => receipt.sequence > lastReceipt),
    ],
    logs,
    nextLogSequence: update.nextLogSequence,
    logsTruncated: truncated,
  };
}
/** Shared by web/desktop/mobile. Every command and subscription takes the registry's environment key. */
export function createSimBuildEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    view: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:sim-build:view",
      tag: SIM_BUILD_WS_METHODS.subscribe,
      idleTtlMs: 0,
      transform: (stream) =>
        stream.pipe(Stream.scan(EMPTY_SIM_BUILD_VIEW, applySimBuildUpdate), Stream.drop(1)),
    }),
    discover: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sim-build:discover",
      tag: SIM_BUILD_WS_METHODS.discover,
    }),
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sim-build:start",
      tag: SIM_BUILD_WS_METHODS.start,
    }),
    list: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sim-build:list",
      tag: SIM_BUILD_WS_METHODS.list,
    }),
    get: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sim-build:get",
      tag: SIM_BUILD_WS_METHODS.get,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:sim-build:cancel",
      tag: SIM_BUILD_WS_METHODS.cancel,
    }),
  };
}
