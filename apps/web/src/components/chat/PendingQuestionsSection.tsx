import type { RuntimeRequestId } from "@spiritdevs/contracts";
import { MessageCircleQuestionIcon, XIcon } from "lucide-react";
import type { PendingUserInput } from "../../session-logic";

export function PendingQuestionsSection({
  prompts,
  respondingRequestIds,
  onOpen,
  onIgnore,
  canIgnore = false,
}: {
  prompts: readonly PendingUserInput[];
  respondingRequestIds: readonly RuntimeRequestId[];
  onOpen: (requestId: RuntimeRequestId) => void;
  onIgnore: (requestId: RuntimeRequestId) => void;
  canIgnore?: boolean;
}) {
  if (prompts.length === 0) return null;
  return (
    <section aria-label="Pending questions" className="border-t border-border/65">
      <h3 className="px-3.5 pb-1 pt-3 text-[11px] font-medium text-muted-foreground">
        Pending questions
      </h3>
      <div className="flex max-h-64 flex-col gap-1 overflow-y-auto px-2 pb-2.5">
        {prompts.map((prompt) => {
          const title = prompt.questions.map((question) => question.question).join("\n");
          const busy = respondingRequestIds.includes(prompt.requestId);
          return (
            <div key={prompt.requestId} className="flex items-start gap-1">
              <button
                type="button"
                className="flex min-w-0 flex-1 items-start gap-2 rounded-lg px-1.5 py-2 text-left text-xs hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
                disabled={busy || prompt.responseCapability === "not_resumable"}
                onClick={() => onOpen(prompt.requestId)}
                title={title}
              >
                <MessageCircleQuestionIcon className="size-4 shrink-0" aria-hidden="true" />
                <span className="line-clamp-3 whitespace-pre-wrap break-words">{title}</span>
              </button>
              {canIgnore && (
                <button
                  type="button"
                  className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50"
                  aria-label={`Ignore question: ${title}`}
                  title="Ignore question"
                  disabled={busy}
                  onClick={() => onIgnore(prompt.requestId)}
                >
                  <XIcon className="size-4" aria-hidden="true" />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
