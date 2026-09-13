import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "../ui/dialog";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { OrchestratorAvatar } from "./OrchestratorAvatar";
import { useOrchestrators } from "./OrchestratorContext";

export function NewConversationDialog() {
  const state = useOrchestrators();
  const navigate = useNavigate();
  const [ids, setIds] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [lead, setLead] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const contacts = state.contacts.filter((contact) => contact.status !== "archived");
  const leadId = ids.includes(lead) ? lead : (ids[0] ?? "");
  return (
    <Dialog open={state.newChatOpen} onOpenChange={state.setNewChatOpen}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>New conversation</DialogTitle>
          <DialogDescription>Message an orchestrator, or bring a few together.</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            setSaving(true);
            setError(undefined);
            void state
              .request("aiOrchestrators:createChat", {
                title:
                  title.trim() ||
                  contacts
                    .filter((contact) => ids.includes(contact.id))
                    .map((contact) => contact.name)
                    .join(" + "),
                orchestratorIds: ids,
                leadId,
                companyIds: state.companyId ? [state.companyId] : [],
              })
              .then((id) => {
                if (typeof id === "string") state.selectChat(id);
                state.setNewChatOpen(false);
                setIds([]);
                setTitle("");
              })
              .catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : String(cause)),
              )
              .finally(() => setSaving(false));
          }}
        >
          <div className="grid gap-4 px-6 pb-6">
            <Input
              aria-label="Conversation name"
              placeholder="Conversation name (optional)"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={120}
            />
            <div className="max-h-72 overflow-y-auto space-y-1">
              {contacts.map((contact) => (
                <label
                  key={contact.id}
                  className="flex cursor-pointer items-center gap-3 rounded-xl p-3 hover:bg-muted/60"
                >
                  <OrchestratorAvatar contact={contact} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{contact.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {contact.kind === "project"
                        ? "Project coordinator"
                        : contact.kind === "personal"
                          ? "Personal assistant"
                          : "Specialist"}
                    </span>
                  </span>
                  <input
                    type="checkbox"
                    aria-label={`Include ${contact.name}`}
                    checked={ids.includes(contact.id)}
                    onChange={(event) =>
                      setIds((current) =>
                        event.target.checked
                          ? [...current, contact.id]
                          : current.filter((id) => id !== contact.id),
                      )
                    }
                    className="size-4 accent-blue-500"
                  />
                </label>
              ))}
            </div>
            {ids.length > 1 && (
              <label className="grid gap-2 text-sm">
                Conversation lead
                <select
                  className="rounded-lg border bg-background p-2"
                  value={leadId}
                  onChange={(event) => setLead(event.target.value)}
                >
                  {contacts
                    .filter((contact) => ids.includes(contact.id) && contact.canDirect)
                    .map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {contact.name}
                      </option>
                    ))}
                </select>
                <span className="text-xs text-muted-foreground">
                  Responds when your message does not address someone specific.
                </span>
              </label>
            )}
            <Button
              type="button"
              variant="ghost"
              className="justify-start"
              onClick={() => {
                state.setNewChatOpen(false);
                void navigate({ to: "/settings/orchestrators-overview" });
              }}
            >
              <PlusIcon />
              Create an orchestrator
            </Button>
            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => state.setNewChatOpen(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={
                saving ||
                ids.length === 0 ||
                !contacts.find((contact) => contact.id === leadId)?.canDirect
              }
            >
              {saving ? "Creating…" : "Start conversation"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
