import { XCODE_WS_METHODS } from "@spiritdevs/contracts/xcode";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import { applyXcodeUpdate, EMPTY_XCODE_VIEW } from "./xcodeSetup.ts";

/** Xcode inventory and jobs on one environment's Mac. Mount the view only while it is visible. */
export function createXcodeEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Folds `xcode.subscribe` into an `XcodeView`; the stream closes with the last watcher. */
    view: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:xcode:view",
      tag: XCODE_WS_METHODS.subscribe,
      idleTtlMs: 0,
      transform: (stream) =>
        stream.pipe(Stream.scan(EMPTY_XCODE_VIEW, applyXcodeUpdate), Stream.drop(1)),
    }),
    install: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:xcode:install",
      tag: XCODE_WS_METHODS.install,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:xcode:cancel",
      tag: XCODE_WS_METHODS.cancel,
    }),
    retry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:xcode:retry",
      tag: XCODE_WS_METHODS.retry,
    }),
    approve: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:xcode:approve",
      tag: XCODE_WS_METHODS.approve,
    }),
    select: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:xcode:select",
      tag: XCODE_WS_METHODS.select,
    }),
    installRuntimes: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:xcode:install-runtimes",
      tag: XCODE_WS_METHODS.installRuntimes,
    }),
  };
}
