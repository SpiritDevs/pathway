import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { OrchestratorContext } from "../../src/components/orchestrator/OrchestratorContext";
import { WorkList } from "../../src/components/orchestrator/ConversationMetadata";
import { createRootRoute, createRouter, RouterProvider } from "@tanstack/react-router";
import "./review.css";
const work = {
  id: "worker",
  title: "Review release readiness",
  orchestratorId: "chief",
  threadId: "thread",
  status: "working",
  detail: "Worker is running",
  environmentId: "studio",
  projectId: null,
};
let data = {
  messages: [
    {
      id: "first",
      workId: "worker",
      threadId: "thread",
      text: "Check the failed deployment before changing the release notes.",
      mode: "queue",
      revision: 0,
      position: 1,
      state: "pending",
      detail: "Queued; the environment has not accepted delivery.",
    },
    {
      id: "second",
      workId: "worker",
      threadId: "thread",
      text: "Include the rollback steps in your report.",
      mode: "queue",
      revision: 0,
      position: 2,
      state: "pending",
      detail: "Queued; the environment has not accepted delivery.",
    },
  ],
  questions: [
    {
      id: "question",
      workId: "worker",
      threadId: "child",
      requestId: "request",
      questions: [
        { id: "format", question: "Should the release report include customer-facing wording?" },
      ],
      state: "escalated",
    },
  ],
};
const listeners = new Set();
const emit = () => listeners.forEach((f) => f(structuredClone(data)));
const client = {
  onUpdate(_name, _args, cb) {
    listeners.add(cb);
    cb(structuredClone(data));
    return () => listeners.delete(cb);
  },
};
function App() {
  const [error, setError] = useState();
  const [detail, setDetail] = useState(work.detail);
  const [status, setStatus] = useState(work.status);
  window.cor96 = {
    confirmStop() {
      setStatus("cancelled");
      setDetail("Worker interruption confirmed by environment (fixture).");
    },
    data: () => data,
    accept() {
      data.messages[0].state = "accepted";
      data.messages[0].detail = "Accepted by environment; awaiting durable local dispatch.";
      emit();
    },
    deliver() {
      data.messages[0].state = "delivered";
      data.messages[0].detail =
        "Durable local dispatch confirmed; provider completion is not confirmed.";
      emit();
    },
  };
  const request = async (name, args) => {
    window.cor96Actions ??= [];
    window.cor96Actions.push({ name, args });
    const a = args.action;
    if (name.endsWith(":stop")) {
      setDetail("Stop requested. Waiting for the environment to confirm interruption.");
      return;
    }
    if (a.kind === "sendWork")
      data.messages.push({
        id: a.id,
        workId: "worker",
        threadId: "thread",
        text: a.text,
        mode: a.mode,
        revision: 0,
        position: data.messages.length + 1,
        state: "pending",
        detail: "Queued; the environment has not accepted delivery.",
      });
    if (a.kind === "editWorkMessage") {
      const m = data.messages.find((m) => m.id === a.id);
      m.text = a.text;
      m.revision++;
    }
    if (a.kind === "removeWorkMessage") data.messages = data.messages.filter((m) => m.id !== a.id);
    if (a.kind === "reorderWorkMessages")
      data.messages = a.ids.map((id, i) => ({
        ...data.messages.find((m) => m.id === id),
        position: i + 1,
      }));
    if (a.kind === "answerWorkQuestion") data.questions[0].state = "answering";
    emit();
  };
  return (
    <OrchestratorContext.Provider
      value={{
        client,
        accountID: "fixture",
        selected: { id: "chat" },
        contacts: [{ id: "chief", canDirect: true, capabilities: ["threads.control"] }],
        request,
        setError,
      }}
    >
      <main className="min-h-screen bg-background p-5 text-foreground sm:p-10">
        <div className="mx-auto max-w-2xl">
          <p className="text-xs text-muted-foreground">
            Pathway · Component fixture · Simulated backend, no live worker
          </p>
          <h1 className="mt-2 text-2xl font-semibold">Release coordination</h1>
          <p className="mt-2 text-sm text-muted-foreground">Worker conversation controls</p>
          <article className="mt-6 rounded-xl border p-5">
            {error && <p role="alert">{error}</p>}
            <WorkList items={[{ ...work, status, detail }]} />
          </article>
        </div>
      </main>
    </OrchestratorContext.Provider>
  );
}
const routeTree = createRootRoute({ component: App });
const router = createRouter({ routeTree });
createRoot(document.getElementById("root")).render(<RouterProvider router={router} />);
