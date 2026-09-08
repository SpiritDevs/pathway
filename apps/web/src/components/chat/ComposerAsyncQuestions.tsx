import type { RuntimeRequestId } from "@spiritdevs/contracts";
import { MessageCircleQuestionIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { PendingUserInput } from "../../session-logic";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";

/** Defaults are suggestions only; submitting always requires an explicit action. */
export function initialAsyncQuestionAnswers(
  prompt: PendingUserInput,
): Record<string, PendingUserInputDraftAnswer> {
  return Object.fromEntries(
    prompt.questions.map((question) => [
      question.id,
      {
        selectedOptionLabels: question.options[0] ? [question.options[0].label] : [],
        isImplicitSelection: true,
      },
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
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className="flex items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-sm hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
            onClick={() => onOpen(prompt.requestId)}
          />
        }
      >
        <MessageCircleQuestionIcon className="size-4" aria-hidden="true" />
        Question
      </TooltipTrigger>
      <TooltipPopup className="max-w-sm whitespace-pre-wrap" align="start">
        {prompt.questions.map((question) => question.question).join("\n\n")}
      </TooltipPopup>
    </Tooltip>
  );
}
