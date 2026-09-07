import { RuntimeRequestId } from "@spiritdevs/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
} from "../../pendingUserInput";
import type { PendingUserInput } from "../../session-logic";
import { ComposerAsyncQuestions, initialAsyncQuestionAnswers } from "./ComposerAsyncQuestions";

const prompt: PendingUserInput = {
  requestId: RuntimeRequestId.make("async-request"),
  createdAt: "2026-09-07T00:00:00Z",
  responseCapability: "message",
  isBlocking: false,
  questions: [
    {
      id: "approach",
      header: "Approach",
      question: "Which approach?",
      options: [
        { label: "Incremental", description: "One step at a time" },
        { label: "All at once", description: "" },
      ],
      multiSelect: false,
    },
    { id: "name", header: "Name", question: "What name?", options: [], multiSelect: false },
  ],
};

describe("async question picker", () => {
  it("announces the question count without opening the picker or submitting", () => {
    let submissions = 0;
    const markup = renderToStaticMarkup(
      <ComposerAsyncQuestions
        prompts={[prompt]}
        respondingRequestIds={[]}
        onRespond={async () => {
          submissions++;
          return true;
        }}
      />,
    );
    expect(markup).toContain("Questions");
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('tabular-nums">2');
    expect(markup).not.toContain("Which approach?");
    expect(markup).not.toContain("autofocus");
    expect(submissions).toBe(0);
  });

  it("preselects the first suggestion but waits for every free-form answer", () => {
    const drafts = initialAsyncQuestionAnswers(prompt);
    expect(drafts.approach?.selectedOptionLabels).toEqual(["Incremental"]);
    expect(buildPendingUserInputAnswers(prompt.questions, drafts)).toBeNull();
    drafts.name = setPendingUserInputCustomAnswer(drafts.name, "Pathway");
    expect(buildPendingUserInputAnswers(prompt.questions, drafts)).toEqual({
      approach: "Incremental",
      name: "Pathway",
    });
    drafts.approach = setPendingUserInputCustomAnswer(drafts.approach, "Another approach");
    expect(buildPendingUserInputAnswers(prompt.questions, drafts)).toEqual({
      approach: "Another approach",
      name: "Pathway",
    });
  });

  it("does not show a question button when all groups are resolved", () => {
    expect(
      renderToStaticMarkup(
        <ComposerAsyncQuestions
          prompts={[]}
          respondingRequestIds={[]}
          onRespond={async () => true}
        />,
      ),
    ).toBe("");
  });
});
