import { useAtomValue } from "@effect/atom-react";
import { AgentThreadEntity } from "@spiritdevs/client-runtime/sync";
import { CompanyId } from "@spiritdevs/contracts/company";
import type { Asset } from "@spiritdevs/contracts/assets";
import type { ConvexClient } from "convex/browser";
import * as Schema from "effect/Schema";
import { useMemo, useState } from "react";
import { companyRegistryReplicasAtom } from "../../cloud/companyRegistryReplica";
import { assetFunctions } from "../../cloud/assetClient";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogPopup,
  DialogFooter,
} from "../ui/dialog";
const isThread = Schema.is(AgentThreadEntity);
export function AssetAttachDialog({
  asset,
  client,
  onClose,
}: {
  asset: Asset;
  client: ConvexClient;
  onClose: () => void;
}) {
  const replicas = useAtomValue(companyRegistryReplicasAtom);
  const [search, setSearch] = useState("");
  const [target, setTarget] = useState<AgentThreadEntity | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threads = useMemo(
    () =>
      Array.from(replicas.get(CompanyId.make(asset.companyId))?.view.values() ?? [])
        .filter(isThread)
        .filter((thread) => thread.shell.title.toLowerCase().includes(search.toLowerCase()))
        .slice(0, 50),
    [replicas, asset.companyId, search],
  );
  const attach = async () => {
    if (!target || !confirmed) return;
    setPending(true);
    setError(null);
    try {
      await client.mutation(assetFunctions.attach, {
        companyId: asset.companyId,
        assetId: asset.id,
        context: { kind: "thread", id: target.shell.id, environmentId: target.environmentId },
        confirmBroaderAccess: true,
      });
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not attach asset");
    } finally {
      setPending(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Attach {asset.name}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <Input
            aria-label="Find a thread"
            placeholder="Find a thread"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <ul className="my-3 max-h-64 overflow-auto">
            {threads.map((thread) => (
              <li key={`${thread.environmentId}:${thread.shell.id}`}>
                <button
                  type="button"
                  className="w-full rounded p-2 text-left text-sm hover:bg-muted"
                  aria-pressed={target === thread}
                  onClick={() => {
                    setTarget(thread);
                    setConfirmed(false);
                  }}
                >
                  {target === thread ? "✓ " : ""}
                  {thread.shell.title}
                </button>
              </li>
            ))}
          </ul>
          {threads.length === 0 && <p className="text-sm">No matching threads available.</p>}
          {target && (
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              Allow readers of “{target.shell.title}” to access this asset. This may broaden its
              visibility.
            </label>
          )}
          {error && (
            <p role="alert" className="mt-2 text-sm text-destructive">
              {error}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button disabled={!target || !confirmed || pending} onClick={() => void attach()}>
            Attach to thread
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
