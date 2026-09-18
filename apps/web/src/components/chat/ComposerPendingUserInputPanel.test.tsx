import { RuntimeRequestId } from "@spiritdevs/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
  createRootRoute,
  createRouter,
  createMemoryHistory,
  RouterContextProvider,
} from "@tanstack/react-router";

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import type { PendingUserInput } from "../../session-logic";

const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("request-1"),
  createdAt: "2026-08-15T00:00:00.000Z",
  responseCapability: "live",
  questions: [
    {
      id: "question-1",
      header: "Approach",
      question: "Which approach should the migration take?",
      options: [
        { label: "Incremental", description: "Move one module at a time" },
        { label: "Big bang", description: "Move everything in one release" },
      ],
      multiSelect: false,
    },
  ],
};

function renderPanel(request = prompt, onDismiss?: () => void) {
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });
  return renderToStaticMarkup(
    <RouterContextProvider router={router}>
      <ComposerPendingUserInputPanel
        pendingUserInputs={[request]}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onToggleOption={() => {}}
        onAdvance={() => {}}
        onDismiss={onDismiss}
      />
    </RouterContextProvider>,
  );
}

describe("ComposerPendingUserInputPanel", () => {
  it.each([true, false])("renders Markdown in questions (blocking: %s)", (isBlocking) => {
    const markup = renderPanel({
      ...prompt,
      isBlocking,
      questions: [
        {
          ...prompt.questions[0]!,
          question:
            "Open [settings](https://example.com/settings).\nKeep this line break.\n\n- Choose **Read and write**.\n- Run `gh secret set TOKEN`.\n\nTell me when you are done.",
        },
      ],
    });

    expect(markup).toContain("<strong>Read and write</strong>");
    expect(markup).toMatch(/<code[^>]*>gh secret set TOKEN<\/code>/);
    expect(markup).toContain("<ul>");
    expect(markup).toContain("<li>");
    expect(markup).toContain('href="https://example.com/settings"');
    expect(markup).toContain("<br/>");
    expect(markup).toContain("<p>Tell me when you are done.</p>");
    expect(markup).not.toContain("**Read and write**");
  });

  it("renders the header as a disclosure control for the question body", () => {
    const markup = renderPanel();

    const toggle = markup.match(/<button[^>]*data-pending-user-input-toggle="[^"]*"[^>]*>/)?.[0];
    expect(toggle).toBeDefined();
    expect(toggle).toContain('data-pending-user-input-toggle="expanded"');
    expect(toggle).toContain('aria-expanded="true"');
    expect(toggle).toContain('type="button"');

    const controlledId = toggle?.match(/aria-controls="([^"]+)"/)?.[1];
    expect(controlledId).toBeDefined();
    expect(markup).toMatch(new RegExp(`<div[^>]*\\sid="${controlledId}"`));
  });

  it("allows async follow-up answers and returning to the message composer", () => {
    const markup = renderPanel(
      { ...prompt, isBlocking: false, responseCapability: "message" },
      () => {},
    );
    expect(markup).toContain('aria-label="Close question and return to message"');
    expect(markup).not.toContain('disabled=""');
    expect(markup).not.toContain("<input");
    expect(markup).not.toContain("<textarea");
  });

  it("disables answers for requests that can no longer receive a response", () => {
    const markup = renderPanel({ ...prompt, responseCapability: "not_resumable" });
    expect(markup).toContain('disabled=""');
    expect(markup).not.toContain('aria-label="Close question and return to message"');
  });

  it("starts expanded so the question and its options are visible", () => {
    const markup = renderPanel();

    expect(markup).toContain("Approach");
    expect(markup).toContain("Which approach should the migration take?");
    expect(markup).toContain("Incremental");
    expect(markup).toContain("Big bang");
  });
});
