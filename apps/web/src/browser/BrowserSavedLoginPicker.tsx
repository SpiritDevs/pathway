import { useEffect, useState } from "react";
import type { PreviewTabId, ScopedThreadRef } from "@spiritdevs/contracts";
import {
  browserPasswordFunctions,
  useBrowserPasswordClient,
  type BrowserPasswordMetadata,
} from "~/cloud/browserPasswords";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

export function BrowserSavedLoginPicker({
  threadRef,
  tabId,
  origin,
  fillLogin,
}: {
  threadRef: ScopedThreadRef;
  tabId: PreviewTabId;
  origin: string;
  fillLogin?: (login: { origin: string; username: string; password: string }) => Promise<boolean>;
}) {
  const client = useBrowserPasswordClient();
  const autofill = useAtomCommand(previewEnvironment.remoteCommand, {
    reportFailure: false,
    reportDefect: false,
  });
  const [records, setRecords] = useState<BrowserPasswordMetadata[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string>();
  useEffect(() => {
    setRecords([]);
    setSelectedId("");
    setMessage(undefined);
    if (!client) return;
    return client.onUpdate(browserPasswordFunctions.list, { origin }, setRecords, () =>
      setMessage("Could not load saved logins. Check your account connection."),
    );
  }, [client, origin]);
  const fill = async () => {
    if (!client || !selectedId || busy) return;
    setBusy(true);
    setMessage(undefined);
    try {
      // The selected secret exists only in this call, never in React state or chat messages.
      const login = await client.action(browserPasswordFunctions.getForAutofill, {
        id: selectedId,
        origin,
      });
      const result = fillLogin
        ? await fillLogin(login)
        : (
            await autofill({
              environmentId: threadRef.environmentId,
              input: {
                action: "autofill",
                threadId: threadRef.threadId,
                tabId,
                origin: login.origin,
                username: login.username,
                password: login.password,
              },
            })
          )._tag === "Success";
      setMessage(
        result
          ? "Login filled. Submit the website's sign-in form when ready."
          : "Could not fill this page. Check the website and take control of the browser, then try again.",
      );
    } catch {
      setMessage("Could not unlock this login. Check your account connection and try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="w-full space-y-2 rounded border p-2 text-xs">
      <p>
        Fill a saved login for <strong>{origin}</strong>. This does not submit the form.
      </p>
      {!client ? (
        <p>Sign in to your Pathway account to use saved logins.</p>
      ) : records.length === 0 ? (
        <p>No logins saved for this website. Add one in Settings → General → Passwords.</p>
      ) : (
        <div className="flex gap-2">
          <select
            aria-label="Saved login"
            className="min-w-0 flex-1 rounded border bg-background p-1"
            value={selectedId}
            onChange={(event) => setSelectedId(event.target.value)}
          >
            <option value="">Select a login</option>
            {records.map((record) => (
              <option key={record.id} value={record.id}>
                {record.label} · {record.username}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rounded border px-2"
            disabled={!selectedId || busy}
            onClick={() => void fill()}
          >
            {busy ? "Filling…" : "Fill login"}
          </button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}
