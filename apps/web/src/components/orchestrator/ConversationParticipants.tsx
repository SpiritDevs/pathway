import { useState } from "react";
import type { OrchestratorChat } from "@spiritdevs/contracts/aiOrchestrator";
import { UserPlusIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { useOrchestrators, useOrchestratorQuery } from "./OrchestratorContext";

export function ConversationParticipants({ chat }: { chat: OrchestratorChat }) {
  const state = useOrchestrators();
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState("");
  const [history, setHistory] = useState<"all" | "from-now">("all");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const companyId = chat.companyIds[0];
  const choices = useOrchestratorQuery<{ members: Array<{ subject: string; name: string }> }>(
    state.client,
    state.accountID,
    "aiOrchestrators:configurationChoices",
    open && companyId ? { companyId } : null,
  );
  const contacts = state.contacts.filter(
    (contact) =>
      contact.canDirect &&
      contact.status !== "archived" &&
      !chat.orchestratorIds.includes(contact.id),
  );
  const members =
    choices.value?.members.filter((member) => !chat.participantSubjects.includes(member.subject)) ??
    [];
  const owner = chat.ownerSubject === state.accountID;
  const remove = (participant: { orchestratorId: string } | { subject: string }) => {
    setSaving(true);
    setError(undefined);
    void state
      .request("aiOrchestrators:removeParticipant", { chatId: chat.id, ...participant })
      .catch((cause: unknown) => {
        const message = cause instanceof Error ? cause.message : String(cause);
        setError(message);
        state.setError(message);
      })
      .finally(() => setSaving(false));
  };
  if (!owner)
    return (
      <Button
        variant="ghost"
        size="sm"
        className="mt-4"
        disabled={saving}
        onClick={() => remove({ subject: state.accountID })}
      >
        Leave conversation
      </Button>
    );
  return (
    <>
      <Button variant="outline" size="sm" className="mt-4" onClick={() => setOpen(true)}>
        <UserPlusIcon />
        Add participants
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Add to {chat.title}</DialogTitle>
            <DialogDescription>
              Bring another person or orchestrator into this conversation.
            </DialogDescription>
          </DialogHeader>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setSaving(true);
              setError(undefined);
              const [kind, ...id] = selection.split(":");
              void state
                .request("aiOrchestrators:invite", {
                  chatId: chat.id,
                  history,
                  ...(kind === "orchestrator"
                    ? { orchestratorId: id.join(":") }
                    : { subject: id.join(":") }),
                })
                .then(() => {
                  setOpen(false);
                  setSelection("");
                })
                .catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : String(cause)),
                )
                .finally(() => setSaving(false));
            }}
          >
            <div className="space-y-5 px-6 pb-6">
              <div className="space-y-2">
                <p className="text-sm font-medium">Current participants</p>
                {chat.participantSubjects.map((subject) => (
                  <div key={subject} className="flex items-center justify-between gap-3 text-sm">
                    <span>
                      {subject === state.accountID
                        ? "You"
                        : (choices.value?.members.find((member) => member.subject === subject)
                            ?.name ?? "Workspace member")}
                    </span>
                    {subject !== chat.ownerSubject && (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={saving}
                        onClick={() => remove({ subject })}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                ))}
                {chat.orchestratorIds.map((orchestratorId) => (
                  <div
                    key={orchestratorId}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span>
                      {state.contacts.find((contact) => contact.id === orchestratorId)?.name ??
                        "Orchestrator"}
                    </span>
                    {orchestratorId === chat.leadId ? (
                      <span className="text-xs text-muted-foreground">Lead</span>
                    ) : (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={saving}
                        onClick={() => remove({ orchestratorId })}
                      >
                        Remove
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              {chat.orchestratorIds.length > 1 && (
                <label className="grid gap-2 text-sm">
                  Conversation lead
                  <select
                    className="rounded-lg border bg-background p-2"
                    aria-label="Conversation lead"
                    value={chat.leadId}
                    disabled={saving}
                    onChange={(event) => {
                      void state
                        .request("aiOrchestrators:updateChat", {
                          chatId: chat.id,
                          leadId: event.target.value,
                        })
                        .catch((cause: unknown) =>
                          setError(cause instanceof Error ? cause.message : String(cause)),
                        );
                    }}
                  >
                    {state.contacts
                      .filter(
                        (contact) => chat.orchestratorIds.includes(contact.id) && contact.canDirect,
                      )
                      .map((contact) => (
                        <option key={contact.id} value={contact.id}>
                          {contact.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <label className="grid gap-2 text-sm">
                Participant
                <select
                  className="rounded-lg border bg-background p-2"
                  aria-label="Participant"
                  value={selection}
                  onChange={(event) => setSelection(event.target.value)}
                >
                  <option value="">Choose a participant</option>
                  <optgroup label="Orchestrators">
                    {contacts.map((contact) => (
                      <option key={contact.id} value={`orchestrator:${contact.id}`}>
                        {contact.name}
                      </option>
                    ))}
                  </optgroup>
                  {!!members.length && (
                    <optgroup label="People">
                      {members.map((member) => (
                        <option key={member.subject} value={`person:${member.subject}`}>
                          {member.name}
                        </option>
                      ))}
                    </optgroup>
                  )}
                </select>
              </label>
              <label className="grid gap-2 text-sm">
                Conversation history
                <select
                  className="rounded-lg border bg-background p-2"
                  aria-label="Conversation history"
                  value={history}
                  onChange={(event) => setHistory(event.target.value as "all" | "from-now")}
                >
                  <option value="all">Share the whole conversation</option>
                  <option value="from-now">Only messages from now</option>
                </select>
                <span className="text-xs text-muted-foreground">
                  Other conversations and private memories stay private. Joining does not grant
                  control of another project's work.
                </span>
              </label>
              {(error ?? choices.error) && (
                <p role="alert" className="text-sm text-destructive">
                  {error ?? choices.error}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving || !selection}>
                {saving ? "Adding…" : "Add participant"}
              </Button>
            </DialogFooter>
          </form>
        </DialogPopup>
      </Dialog>
    </>
  );
}
