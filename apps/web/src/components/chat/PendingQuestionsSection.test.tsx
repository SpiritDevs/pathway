import { RuntimeRequestId } from "@spiritdevs/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import type { PendingUserInput } from "../../session-logic";
import { PendingQuestionsSection } from "./PendingQuestionsSection";

const prompts: PendingUserInput[] = ["First question?", "Older question?"].map((question, i) => ({
  requestId: RuntimeRequestId.make(`request-${i}`),
  createdAt: "2026-09-11T00:00:00Z",
  responseCapability: "message",
  isBlocking: false,
  questions: [{ id: "question", header: "Question", question, options: [], multiSelect: false }],
}));
const noop = () => {};

describe("pending questions palette", () => {
  it("shows every request with a separate ignore button", () => {
    const html = renderToStaticMarkup(
      <PendingQuestionsSection
        canIgnore
        prompts={prompts}
        respondingRequestIds={[]}
        onOpen={noop}
        onIgnore={noop}
      />,
    );
    expect(html).toContain("First question?");
    expect(html).toContain("Older question?");
    expect(html.match(/title="Ignore question"/g)).toHaveLength(2);
  });
  it("keeps answering available but hides Ignore on older servers", () => {
    const html = renderToStaticMarkup(
      <PendingQuestionsSection
        prompts={prompts}
        respondingRequestIds={[]}
        onOpen={noop}
        onIgnore={noop}
      />,
    );
    expect(html).toContain("First question?");
    expect(html).not.toContain("Ignore question");
  });
  it("hides the section after the last request is resolved", () => {
    expect(
      renderToStaticMarkup(
        <PendingQuestionsSection
          canIgnore
          prompts={[]}
          respondingRequestIds={[]}
          onOpen={noop}
          onIgnore={noop}
        />,
      ),
    ).toBe("");
  });
  it("allows ignoring a stale request while disabling answering", () => {
    const html = renderToStaticMarkup(
      <PendingQuestionsSection
        canIgnore
        prompts={[{ ...prompts[0]!, responseCapability: "not_resumable" }]}
        respondingRequestIds={[]}
        onOpen={noop}
        onIgnore={noop}
      />,
    );
    expect(html.match(/disabled=""/g)).toHaveLength(1);
    expect(html).toContain("Ignore question: First question?");
  });
  it("disables both actions while the request is being submitted", () => {
    const html = renderToStaticMarkup(
      <PendingQuestionsSection
        canIgnore
        prompts={[prompts[0]!]}
        respondingRequestIds={[prompts[0]!.requestId]}
        onOpen={noop}
        onIgnore={noop}
      />,
    );
    expect(html.match(/disabled=""/g)).toHaveLength(2);
  });
});
