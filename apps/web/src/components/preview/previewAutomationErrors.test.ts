import { EnvironmentId, PreviewTabId, ThreadId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  PreviewAutomationBrowserPageHostError,
  PreviewAutomationOperationError,
  serializePreviewAutomationHostError,
} from "./previewAutomationErrors";

describe("PreviewAutomationBrowserPageHostError", () => {
  const error = new PreviewAutomationBrowserPageHostError({
    requestId: "request-1",
    operation: "evaluate",
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    tabId: PreviewTabId.make("tab-1"),
  });

  it("reaches the server as the browser page error the agent is told about", () => {
    expect(serializePreviewAutomationHostError(error)).toMatchObject({
      _tag: "PreviewAutomationBrowserPageError",
      detail: { operation: "evaluate", tabId: "tab-1" },
    });
  });

  it("is not collapsed into a generic failure", () => {
    expect(
      PreviewAutomationOperationError.fromCause({
        requestId: "request-1",
        operation: "evaluate",
        environmentId: EnvironmentId.make("environment-1"),
        threadId: ThreadId.make("thread-1"),
        tabId: PreviewTabId.make("tab-1"),
        cause: error,
      }),
    ).toBe(error);
  });
});
