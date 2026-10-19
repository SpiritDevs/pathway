import { useAtomValue } from "@effect/atom-react";
import type { ConversationShare, ConversationShareAccess } from "@spiritdevs/contracts";
import { useEffect, useState } from "react";

import {
  conversationSharingMutationsAtom,
  type ConversationRecipient,
} from "../../cloud/conversationSharing";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle, DialogDescription } from "../ui/dialog";

export function ShareConversationDialog(props: {
  environmentId: string;
  threadId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mutations = useAtomValue(conversationSharingMutationsAtom);
  const [recipients, setRecipients] = useState<ConversationRecipient[]>([]);
  const [shares, setShares] = useState<ConversationShare[]>([]);
  const [selected, setSelected] = useState("");
  const [access, setAccess] = useState<ConversationShareAccess>("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!props.open || mutations === null) return;
    let active = true;
    setError(null);
    setSelected("");
    setRecipients([]);
    setShares([]);
    const address = { environmentId: props.environmentId, threadId: props.threadId };
    void Promise.all([mutations.recipients(address), mutations.shares(address)])
      .then(([people, current]) => {
        if (active) {
          setRecipients(people);
          setShares(current);
        }
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "Could not load sharing.");
      });
    return () => {
      active = false;
    };
  }, [mutations, props.environmentId, props.threadId, props.open]);

  const save = async (operation: () => Promise<unknown>) => {
    if (mutations === null || busy) return;
    setBusy(true);
    setError(null);
    try {
      await operation();
      setShares(
        await mutations.shares({ environmentId: props.environmentId, threadId: props.threadId }),
      );
      setSelected("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update sharing.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="w-full p-5">
        <DialogTitle>Share conversation</DialogTitle>
        <DialogDescription>
          Choose someone from a company you belong to. You can change or remove their access here.
        </DialogDescription>
        <div className="mt-4 grid gap-3">
          <label className="grid gap-1 text-sm">
            Person
            <select
              className="rounded-md border bg-background p-2"
              value={selected}
              disabled={busy || mutations === null}
              onChange={(event) => setSelected(event.currentTarget.value)}
            >
              <option value="">Choose a person</option>
              {recipients.map((person) => (
                <option
                  key={`${person.companyId}:${person.userId}`}
                  value={`${person.companyId}:${person.userId}`}
                >
                  {person.name} · {person.companyName}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            Access
            <select
              className="rounded-md border bg-background p-2"
              value={access}
              disabled={busy}
              onChange={(event) =>
                setAccess(event.currentTarget.value === "collaborate" ? "collaborate" : "view")
              }
            >
              <option value="view">Can view</option>
              <option value="collaborate">Can collaborate</option>
            </select>
          </label>
          <p className="text-xs text-muted-foreground">
            Collaborators can send messages and respond to the agent. Only you can attach a project,
            delete the conversation, or manage sharing.
          </p>
          <Button
            disabled={!selected || busy || mutations === null}
            onClick={() => {
              const person = recipients.find(
                (candidate) => `${candidate.companyId}:${candidate.userId}` === selected,
              );
              if (person !== undefined && mutations !== null)
                void save(() =>
                  mutations.share({
                    environmentId: props.environmentId,
                    threadId: props.threadId,
                    companyId: person.companyId,
                    recipientUserId: person.userId,
                    access,
                  }),
                );
            }}
          >
            Share
          </Button>
          {shares.map((share) => (
            <div key={share.id} className="flex items-center gap-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate">{share.recipientName}</div>
                <div className="text-xs text-muted-foreground">
                  {share.companyName} · {share.access === "view" ? "Can view" : "Can collaborate"}
                </div>
              </div>
              <Button
                size="xs"
                variant="ghost"
                disabled={busy || mutations === null}
                onClick={() => {
                  if (mutations !== null) void save(() => mutations.revoke(share.id));
                }}
              >
                Remove
              </Button>
            </div>
          ))}
          {error !== null ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              {error}
            </p>
          ) : null}
        </div>
      </DialogPopup>
    </Dialog>
  );
}
