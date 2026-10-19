import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@spiritdevs/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";
import {
  linkPrimaryEnvironmentToCloud,
  type CloudLinkMode,
  type CloudLinkTarget,
  unlinkPrimaryEnvironmentFromCloud,
  unlinkRelayEnvironmentFromAccount,
  updatePrimaryCloudPreferences,
} from "./linkEnvironment";

const cloudLinkScheduler = createAtomCommandScheduler();
const cloudLinkConcurrency = {
  mode: "serial" as const,
  key: (input: { readonly target: CloudLinkTarget }) => input.target.environmentId,
};

export const linkPrimaryEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cloud:link-primary-environment",
  scheduler: cloudLinkScheduler,
  concurrency: cloudLinkConcurrency,
  execute: (input: {
    readonly target: CloudLinkTarget;
    readonly clerkToken: string;
    readonly mode?: CloudLinkMode;
  }) => linkPrimaryEnvironmentToCloud(input),
});

export const unlinkPrimaryEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cloud:unlink-primary-environment",
  scheduler: cloudLinkScheduler,
  concurrency: cloudLinkConcurrency,
  execute: (input: { readonly target: CloudLinkTarget; readonly clerkToken: string | null }) =>
    unlinkPrimaryEnvironmentFromCloud(input),
});

export const updatePrimaryEnvironmentPreferences = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cloud:update-primary-environment-preferences",
  scheduler: cloudLinkScheduler,
  concurrency: cloudLinkConcurrency,
  execute: (input: { readonly target: CloudLinkTarget; readonly publishAgentActivity: boolean }) =>
    updatePrimaryCloudPreferences(input),
});

export const unlinkRelayEnvironment = createRuntimeCommand(connectionAtomRuntime, {
  label: "web:cloud:unlink-relay-environment",
  scheduler: cloudLinkScheduler,
  concurrency: {
    mode: "serial" as const,
    key: (input: { readonly environmentId: string }) => input.environmentId,
  },
  execute: unlinkRelayEnvironmentFromAccount,
});
