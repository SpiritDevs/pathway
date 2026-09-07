import { useEffect, useState } from "react";
import type { RuntimeRequestId } from "@spiritdevs/contracts";
import { MessageCircleQuestionIcon } from "lucide-react";
import type { PendingUserInput } from "../../session-logic";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { Popover, PopoverClose, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

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

/** Keeps its drafts mounted while the popup closes or the connection refreshes. */
export function ComposerAsyncQuestions({
  prompts,
  respondingRequestIds,
  onRespond,
}: {
  prompts: PendingUserInput[];
  respondingRequestIds: RuntimeRequestId[];
  onRespond: (
    requestId: RuntimeRequestId,
    answers: Record<string, string | string[]>,
  ) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [selectedRequestId, setSelectedRequestId] = useState<string>();
  const [drafts, setDrafts] = useState<Record<string, Record<string, PendingUserInputDraftAnswer>>>(
    {},
  );
  const [failedRequestId, setFailedRequestId] = useState<string>();
  const [submittingRequestId, setSubmittingRequestId] = useState<string>();
  useEffect(() => {
    if (prompts.length === 0) setOpen(false);
  }, [prompts.length]);
  const prompt = prompts.find((entry) => entry.requestId === selectedRequestId) ?? prompts[0];
  if (!prompt) return null;
  const answers = drafts[prompt.requestId] ?? initialAsyncQuestionAnswers(prompt);
  const resolved = buildPendingUserInputAnswers(prompt.questions, answers);
  const disabled =
    prompt.responseCapability === "not_resumable" ||
    submittingRequestId === prompt.requestId ||
    respondingRequestIds.includes(prompt.requestId);
  const count = prompts.reduce((total, entry) => total + entry.questions.length, 0);
  const updateAnswer = (questionId: string, answer: PendingUserInputDraftAnswer) => {
    setDrafts((existing) => ({
      ...existing,
      [prompt.requestId]: {
        ...(existing[prompt.requestId] ?? initialAsyncQuestionAnswers(prompt)),
        [questionId]: answer,
      },
    }));
  };
  const submit = async () => {
    if (disabled || !resolved) return;
    const requestId = prompt.requestId;
    setSubmittingRequestId(requestId);
    setFailedRequestId(undefined);
    try {
      if (await onRespond(requestId, resolved)) {
        setDrafts((existing) => {
          const next = { ...existing };
          delete next[requestId];
          return next;
        });
        setOpen(false);
      } else setFailedRequestId(requestId);
    } catch {
      setFailedRequestId(requestId);
    } finally {
      setSubmittingRequestId(undefined);
    }
  };
  return (
    <div className="relative mx-auto mb-2 w-full max-w-3xl">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger className="flex items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-sm">
          <MessageCircleQuestionIcon className="size-4" aria-hidden="true" />
          Questions <span className="tabular-nums">{count}</span>
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          align="start"
          className="w-[min(30rem,calc(100vw-2rem))]"
          viewportClassName="max-h-[60vh] overflow-y-auto"
        >
          <div className="flex items-center justify-between gap-3">
            <PopoverTitle className="text-base">Questions from the agent</PopoverTitle>
            <PopoverClose className="rounded px-2 py-1 text-sm">Close</PopoverClose>
          </div>
          {prompts.length > 1 && (
            <label className="mt-3 block text-sm">
              Question group
              <select
                className="mt-1 w-full rounded border bg-background p-2"
                value={prompt.requestId}
                onChange={(event) => setSelectedRequestId(event.target.value)}
              >
                {prompts.map((entry, index) => (
                  <option key={entry.requestId} value={entry.requestId}>
                    {index + 1}. {entry.questions[0]?.header || "Questions"}
                  </option>
                ))}
              </select>
            </label>
          )}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            {prompt.questions.map((question) => {
              const draft = answers[question.id];
              return (
                <fieldset key={question.id} disabled={disabled} className="mt-4 space-y-2">
                  <legend className="mb-2 text-sm font-medium">{question.question}</legend>
                  {question.options.map((option) => (
                    <label
                      key={option.label}
                      className="flex cursor-pointer gap-2 rounded border p-2 text-sm"
                    >
                      <input
                        type={question.multiSelect ? "checkbox" : "radio"}
                        name={`${prompt.requestId}:${question.id}`}
                        checked={
                          !draft?.customAnswer?.trim() &&
                          (draft?.selectedOptionLabels?.includes(option.label) ?? false)
                        }
                        onChange={() =>
                          updateAnswer(
                            question.id,
                            togglePendingUserInputOptionSelection(question, draft, option.label),
                          )
                        }
                      />
                      <span>
                        {option.label}
                        {option.description && (
                          <span className="block text-xs text-muted-foreground">
                            {option.description}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                  <label className="block text-sm">
                    {question.options.length ? "Or write your own answer" : "Your answer"}
                    <input
                      className="mt-1 w-full rounded border bg-background p-2"
                      type={question.isSecret ? "password" : "text"}
                      autoComplete="off"
                      value={draft?.customAnswer ?? ""}
                      onChange={(event) =>
                        updateAnswer(
                          question.id,
                          setPendingUserInputCustomAnswer(draft, event.target.value),
                        )
                      }
                    />
                  </label>
                </fieldset>
              );
            })}
            {prompt.responseCapability === "not_resumable" && (
              <p className="mt-3 text-sm text-muted-foreground">
                This question can no longer receive an answer.
              </p>
            )}
            {failedRequestId === prompt.requestId && (
              <p role="alert" className="mt-3 text-sm text-destructive">
                Couldn't send your answers. Your draft is saved here; try again.
              </p>
            )}
            <button
              type="submit"
              disabled={disabled || !resolved}
              className="mt-4 rounded bg-primary px-3 py-2 text-sm text-primary-foreground disabled:opacity-50"
            >
              {submittingRequestId === prompt.requestId ? "Sending…" : "Send answers"}
            </button>
          </form>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
