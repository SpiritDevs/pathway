import { useEffect, useState } from "react";
import {
  browserPasswordFunctions,
  useBrowserPasswordClient,
  type BrowserPasswordMetadata,
} from "~/cloud/browserPasswords";
import { randomUUID } from "~/lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";

const emptyDraft = () => ({ id: randomUUID(), label: "", origin: "", username: "", password: "" });

export function BrowserPasswordsSettings() {
  const client = useBrowserPasswordClient();
  const [records, setRecords] = useState<BrowserPasswordMetadata[]>([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [editingRevision, setEditingRevision] = useState<number>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string>();
  useEffect(() => {
    setRecords([]);
    setDraft(emptyDraft());
    setEditingRevision(undefined);
    setError(undefined);
    if (!client) return;
    return client.onUpdate(browserPasswordFunctions.list, {}, setRecords, (failure) =>
      setError(failure.message),
    );
  }, [client]);
  const reset = () => {
    setDraft(emptyDraft());
    setEditingRevision(undefined);
  };
  const save = async () => {
    if (!client || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.action(browserPasswordFunctions.save, {
        ...draft,
        ...(editingRevision === undefined ? {} : { expectedRevision: editingRevision }),
      });
      reset();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not save this password.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async (record: BrowserPasswordMetadata) => {
    if (!client || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await client.mutation(browserPasswordFunctions.remove, {
        id: record.id,
        expectedRevision: record.revision,
      });
      setConfirmDelete(undefined);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Could not delete this password.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsSection title="Passwords" id="browser-passwords">
      <div className="space-y-4 px-4 py-3">
        <p className="text-sm text-muted-foreground">
          Save website logins to your Pathway account. Passwords are encrypted on Pathway's servers
          and sync across your devices. Select a login in the browser to fill it. Filling a login
          does not add its password to the conversation.
        </p>
        {!client ? (
          <p className="text-sm text-muted-foreground">
            Sign in to your Pathway account to manage passwords.
          </p>
        ) : (
          <>
            {records.map((record) => (
              <div key={record.id} className="flex flex-wrap items-center gap-2 rounded border p-3">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium">{record.label}</p>
                  <p className="break-all text-xs text-muted-foreground">
                    {record.origin} · {record.username}
                  </p>
                </div>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setDraft({
                      id: record.id,
                      label: record.label,
                      origin: record.origin,
                      username: record.username,
                      password: "",
                    });
                    setEditingRevision(record.revision);
                  }}
                >
                  Replace password
                </Button>
                {confirmDelete === record.id ? (
                  <>
                    <Button
                      size="xs"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void remove(record)}
                    >
                      Delete password
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setConfirmDelete(undefined)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setConfirmDelete(record.id)}
                  >
                    Delete
                  </Button>
                )}
              </div>
            ))}
            <form
              className="grid gap-3 rounded border p-3 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <p className="text-sm font-medium sm:col-span-2">
                {editingRevision === undefined ? "Add a saved login" : "Replace saved login"}
              </p>
              <label className="space-y-1 text-xs">
                Label
                <Input
                  required
                  disabled={busy}
                  value={draft.label}
                  maxLength={200}
                  onChange={(event) => setDraft({ ...draft, label: event.target.value })}
                />
              </label>
              <label className="space-y-1 text-xs">
                Website
                <Input
                  required
                  disabled={busy}
                  type="url"
                  placeholder="https://example.com"
                  value={draft.origin}
                  maxLength={2048}
                  onChange={(event) => setDraft({ ...draft, origin: event.target.value })}
                />
              </label>
              <label className="space-y-1 text-xs">
                Username
                <Input
                  disabled={busy}
                  autoComplete="off"
                  value={draft.username}
                  maxLength={1024}
                  onChange={(event) => setDraft({ ...draft, username: event.target.value })}
                />
              </label>
              <label className="space-y-1 text-xs">
                Password
                <Input
                  required
                  disabled={busy}
                  type="password"
                  autoComplete="new-password"
                  value={draft.password}
                  maxLength={16384}
                  onChange={(event) => setDraft({ ...draft, password: event.target.value })}
                />
              </label>
              <div className="flex gap-2 sm:col-span-2">
                <Button type="submit" size="sm" disabled={busy}>
                  {busy ? "Saving…" : "Save login"}
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={reset}>
                  Cancel
                </Button>
              </div>
            </form>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    </SettingsSection>
  );
}
