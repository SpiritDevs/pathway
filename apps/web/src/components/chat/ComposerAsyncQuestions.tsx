import type { RuntimeRequestId } from "@spiritdevs/contracts";
import { MessageCircleQuestionIcon } from "lucide-react";
import type { PendingUserInput } from "../../session-logic";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";

/** Defaults are suggestions only; submitting always requires an explicit action. */
export function initialAsyncQuestionAnswers(
  prompt: PendingUserInput,
): Record<string, PendingUserInputDraftAnswer> {
  return Object.fromEntries(
    prompt.questions.map((question) => [
      question.id,
      { selectedOptionLabels: question.options[0] ? [question.options[0].label] : [] },
    ]),
  );
}

/** Opens the request in the question panel attached to the composer. */
export function ComposerAsyncQuestions({
  prompts,
  onOpen,
}: {
  prompts: PendingUserInput[];
  onOpen: (requestId: RuntimeRequestId) => void;
}) {
  const prompt = prompts[0];
  if (!prompt) return null;
  return (
    <button
      type="button"
      className="mt-2 flex items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-sm"
      onClick={() => onOpen(prompt.requestId)}
    >
      <MessageCircleQuestionIcon className="size-4" aria-hidden="true" />
      Questions <span className="tabular-nums">{prompt.questions.length}</span>
    </button>
  );
}
