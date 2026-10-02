import type { DiscoveredLocalServer, ScopedThreadRef } from "@spiritdevs/contracts";
import {
  mapAtomCommandResult,
  type AtomCommandResult,
} from "@spiritdevs/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";

import { readEnvironmentOnThisMachine, remoteBrowserEnabled } from "~/browser/browserPlacement";
import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import type { OpenPreviewMutation } from "~/browser/openFileInPreview";
import { openRemoteBrowser } from "~/browser/remoteBrowserStore";
import { recordVisitForThread } from "~/browserHistoryStore";
import { useRightPanelStore } from "~/rightPanelStore";
import { openPreviewSession } from "./openPreviewSession";

/**
 * Opens a server discovered on the thread's environment. It listens on the
 * environment's localhost, so it opens in the environment's own browser unless
 * the environment is this machine.
 */
export async function openDiscoveredPort<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly port: DiscoveredLocalServer;
  readonly openPreview: OpenPreviewMutation<E>;
}): Promise<AtomCommandResult<void, E>> {
  if (remoteBrowserEnabled && !readEnvironmentOnThisMachine(input.threadRef.environmentId)) {
    openRemoteBrowser(input.threadRef, { url: input.port.url });
    return AsyncResult.success(undefined);
  }
  const resolvedUrl = resolveDiscoveredServerUrl(input.threadRef.environmentId, input.port.url);
  const result = await openPreviewSession({
    openPreview: input.openPreview,
    threadRef: input.threadRef,
    url: resolvedUrl,
  });
  return mapAtomCommandResult(result, (snapshot) => {
    recordVisitForThread(input.threadRef, input.port.url);
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}
