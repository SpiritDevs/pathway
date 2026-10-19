import { ORCHESTRATION_V2_WS_METHODS } from "@spiritdevs/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "@spiritdevs/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

export const workspaceCleanupNotices = createEnvironmentRpcSubscriptionAtomFamily(
  connectionAtomRuntime,
  {
    label: "environment-data:workspace-cleanup:notices",
    tag: ORCHESTRATION_V2_WS_METHODS.subscribeWorkspaceCleanup,
    idleTtlMs: 0,
  },
);

export const retryWorkspaceCleanup = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-data:workspace-cleanup:retry",
  tag: ORCHESTRATION_V2_WS_METHODS.retryWorkspaceCleanup,
});
