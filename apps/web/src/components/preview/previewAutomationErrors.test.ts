import { EnvironmentId, PreviewTabId, ThreadId } from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assertPreviewAutomationWebPage,
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

describe("assertPreviewAutomationWebPage", () => {
  const context = {
    requestId: "request-1",
    operation: "click",
    environmentId: EnvironmentId.make("environment-1"),
    threadId: ThreadId.make("thread-1"),
    tabId: PreviewTabId.make("tab-1"),
  } as const;

  it("lets agents use websites, blank tabs and tabs that have not loaded yet", () => {
    for (const url of ["https://example.com", "http://localhost:3000", "about:blank", null]) {
      expect(() => assertPreviewAutomationWebPage(url, context)).not.toThrow();
    }
  });

  it("refuses browser pages with the error the agent is told about", () => {
    for (const url of [
      "chrome://settings/content/siteDetails?site=https%3A%2F%2Fexample.com",
      "data:text/html,hello",
    ]) {
      expect(() => assertPreviewAutomationWebPage(url, context)).toThrow(
        new PreviewAutomationBrowserPageHostError(context),
      );
    }
  });
});
