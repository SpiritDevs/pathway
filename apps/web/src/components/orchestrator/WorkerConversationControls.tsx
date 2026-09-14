import { useRef, useState } from "react";
import type {
  OrchestratorWorkerAction,
  OrchestratorWorkerMessage,
  OrchestratorWorkerQuestion,
  OrchestratorWorkItem,
} from "@spiritdevs/contracts/aiOrchestrator";
import { Button } from "../ui/button";
import { useOrchestrators, useOrchestratorQuery } from "./OrchestratorContext";
import { randomUUID } from "../../lib/utils";

type Conversation = {
  messages: OrchestratorWorkerMessage[];
  questions: OrchestratorWorkerQuestion[];
};
export function WorkerConversationControls({ work }: { work: OrchestratorWorkItem }) {
  const state = useOrchestrators();
  const chat = state.selected;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"queue" | "steer">("queue");
  const [editing, setEditing] = useState<OrchestratorWorkerMessage | null>(null);
  const pendingSend = useRef<{ text: string; mode: string; id: string } | null>(null);
  const contact = state.contacts.find((c) => c.id === work.orchestratorId);
  const canControl = contact?.canDirect && contact.capabilities.includes("threads.control");
  const result = useOrchestratorQuery<Conversation>(
    state.client,
    state.accountID,
    "aiOrchestratorControls:conversation",
    open && chat ? { chatId: chat.id, workId: work.id } : null,
  );
  const action = async (action: OrchestratorWorkerAction) => {
    if (!chat || busy) return;
    setBusy(true);
    try {
      await state.request("aiOrchestratorControls:control", {
        chatId: chat.id,
        action:
          action.kind === "reorderWorkMessages" ? { ...action, ids: [...action.ids] } : action,
      });
    } catch (cause) {
      state.setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      setBusy(false);
    }
  };
  const messages = result.value?.messages.filter((m) => m.state !== "removed") ?? [];
  const pending = messages.filter((m) => m.state === "pending");
  return (
    <div className="mt-2">
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="outline" onClick={() => setOpen(!open)} aria-expanded={open}>
          Worker conversation
        </Button>
        {canControl && ["queued", "working", "unknown"].includes(work.status) && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              if (!chat) return;
              setBusy(true);
              void state
                .request("aiOrchestratorControls:stop", { chatId: chat.id, workId: work.id })
                .catch((cause) =>
                  state.setError(cause instanceof Error ? cause.message : String(cause)),
                )
                .finally(() => setBusy(false));
            }}
          >
            Request stop
          </Button>
        )}
      </div>
      {open && (
        <section
          aria-label={`Conversation with ${work.title}`}
          className="mt-3 space-y-3 rounded-lg border p-3"
        >
          <p className="text-xs text-muted-foreground">
            Follow-ups go to this worker. Questions retain their original worker or subagent
            destination. Native subagents cannot be steered independently. Answers and steering go
            before follow-ups waiting for the current turn.
          </p>
          {result.error && (
            <p role="alert" className="text-xs text-destructive">
              {String(result.error)}
            </p>
          )}
          {result.value?.questions
            .filter((q) => ["open", "escalated", "answering"].includes(q.state))
            .map((q) => (
              <WorkerQuestion
                key={q.id}
                question={q}
                disabled={!canControl || busy || q.state === "answering"}
                answer={(id, answers) =>
                  action({
                    kind: "answerWorkQuestion",
                    workId: work.id,
                    id,
                    questionId: q.id,
                    answers,
                  })
                }
              />
            ))}
          {messages.length > 0 && (
            <ol className="space-y-3" aria-label="Worker message queue">
              {messages.map((message) => (
                <li key={message.id} className="border-b pb-2 last:border-0">
                  <p className="whitespace-pre-wrap break-words text-xs">
                    {message.mode === "answer"
                      ? Object.values(message.answers ?? {}).join("\n")
                      : message.text}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {message.state} · {message.detail}
                  </p>
                  {canControl && message.state === "pending" && (
                    <div className="mt-1 flex flex-wrap gap-2">
                      {message.mode !== "answer" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            setEditing(message);
                            setText(message.text);
                          }}
                        >
                          Edit
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => {
                          void action({
                            kind: "removeWorkMessage",
                            workId: work.id,
                            id: message.id,
                            revision: message.revision,
                          }).catch(() => undefined);
                        }}
                      >
                        Remove
                      </Button>
                      {pending.indexOf(message) > 0 && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => {
                            const ids = pending.map((m) => m.id),
                              index = ids.indexOf(message.id);
                            [ids[index - 1], ids[index]] = [ids[index]!, ids[index - 1]!];
                            void action({
                              kind: "reorderWorkMessages",
                              workId: work.id,
                              ids,
                            }).catch(() => undefined);
                          }}
                        >
                          Move up
                        </Button>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
          {canControl && work.threadId && (
            <form
              className="space-y-2"
              onSubmit={(event) => {
                event.preventDefault();
                const saved = pendingSend.current;
                const id = saved?.text === text && saved.mode === mode ? saved.id : randomUUID();
                pendingSend.current = { text, mode, id };
                void action(
                  editing
                    ? {
                        kind: "editWorkMessage",
                        workId: work.id,
                        id: editing.id,
                        revision: editing.revision,
                        text,
                      }
                    : { kind: "sendWork", workId: work.id, id, text, mode },
                )
                  .then(() => {
                    setText("");
                    setEditing(null);
                    pendingSend.current = null;
                  })
                  .catch(() => undefined);
              }}
            >
              <textarea
                className="min-h-20 w-full resize-y rounded-md border bg-background p-2 text-sm"
                aria-label={editing ? "Edit pending follow-up" : "Worker follow-up"}
                placeholder="Follow-up instructions…"
                maxLength={16000}
                value={text}
                onChange={(e) => setText(e.target.value)}
                disabled={busy}
              />
              <div className="flex flex-wrap items-center gap-2">
                {!editing && (
                  <select
                    className="rounded border bg-background p-1 text-xs"
                    aria-label="Follow-up delivery"
                    value={mode}
                    onChange={(e) => setMode(e.target.value === "steer" ? "steer" : "queue")}
                  >
                    <option value="queue">After current turn</option>
                    <option value="steer">Steer running turn</option>
                  </select>
                )}
                <Button size="sm" type="submit" disabled={busy || !text.trim()}>
                  {editing ? "Save edit" : "Send follow-up"}
                </Button>
                {editing && (
                  <Button
                    size="sm"
                    variant="ghost"
                    type="button"
                    onClick={() => {
                      setEditing(null);
                      setText("");
                    }}
                  >
                    Cancel edit
                  </Button>
                )}
              </div>
            </form>
          )}
        </section>
      )}
    </div>
  );
}
function WorkerQuestion({
  question,
  disabled,
  answer,
}: {
  question: OrchestratorWorkerQuestion;
  disabled: boolean;
  answer: (id: string, answers: Record<string, string>) => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const pending = useRef({ id: randomUUID(), text: "" });
  return (
    <form
      className="space-y-2 rounded-md bg-muted/50 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        const text = JSON.stringify(answers);
        if (pending.current.text !== text) pending.current = { id: randomUUID(), text };
        void answer(pending.current.id, answers).catch(() => undefined);
      }}
    >
      <p className="text-xs font-medium">
        {question.state === "escalated"
          ? "Your answer is needed"
          : question.state === "answering"
            ? "Answer queued"
            : "Worker question"}
      </p>
      {question.questions.map((q) => (
        <label key={q.id} className="block text-xs">
          {q.question}
          <textarea
            className="mt-1 min-h-20 w-full resize-y rounded border bg-background p-2"
            rows={3}
            value={answers[q.id] ?? ""}
            onChange={(e) => setAnswers({ ...answers, [q.id]: e.target.value })}
            disabled={disabled}
          />
        </label>
      ))}
      <Button
        type="submit"
        size="sm"
        disabled={disabled || question.questions.some((q) => !answers[q.id]?.trim())}
      >
        Reply to worker
      </Button>
    </form>
  );
}
