import type { ConvexClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";
import { useEffect, useState } from "react";
import { Button } from "../ui/button";
type LegacyAsset = {
  id: string;
  name: string;
  mimeType: string;
  byteSize: number;
  createdAt: number;
  storage: "legacy-public" | "legacy-cloud";
  migrationState: "not-migrated" | "migrated";
  assetId: string | null;
  canMigrate: boolean;
  context?: { kind: "task"; id: string };
};
const legacyList = makeFunctionReference<
  "query",
  { companyId: string; source: "tasks" | "queue"; cursor?: string; limit?: number },
  { items: LegacyAsset[]; nextCursor: string | null }
>("assets:legacyList");
const migrateLegacy = makeFunctionReference<
  "action",
  { companyId: string; source: "tasks" | "queue"; legacyId: string },
  unknown
>("assets:migrateLegacy");

export function LegacyAssetInventory({
  companyId,
  client,
}: {
  companyId: string;
  client: ConvexClient;
}) {
  const [source, setSource] = useState<"tasks" | "queue">("tasks");
  const [items, setItems] = useState<LegacyAsset[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setItems(null);
    setError(null);
    return client.onUpdate(
      legacyList,
      { companyId, source, limit: 50 },
      (page) => {
        setItems(page.items);
        setNext(page.nextCursor);
      },
      (reason) => setError(reason.message),
    );
  }, [companyId, source, client]);
  return (
    <section className="space-y-3" aria-label="Existing uploads">
      <p className="text-sm text-muted-foreground">
        Uploads from earlier versions. Public links remain public until their files have been
        migrated to private storage. Historical workspace files are not uploaded automatically.
      </p>
      <select
        aria-label="Existing upload source"
        value={source}
        onChange={(event) => setSource(event.target.value as "tasks" | "queue")}
        className="rounded border bg-background p-2 text-sm"
      >
        <option value="tasks">Task attachments</option>
        <option value="queue">Cloud queue attachments</option>
      </select>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {items === null && !error && <p role="status">Loading existing uploads…</p>}
      <ul className="divide-y rounded-lg border">
        {items?.map((item) => (
          <li key={item.id} className="flex items-center justify-between gap-3 p-3 text-sm">
            <span className="min-w-0 truncate">
              {item.name}
              <span className="block text-xs text-muted-foreground">
                {(item.byteSize / 1024 / 1024).toFixed(1)} MB ·{" "}
                {item.context ? "Task attachment" : "Queued attachment"}
              </span>
            </span>
            <span
              className={
                item.storage === "legacy-public"
                  ? "rounded-full bg-amber-100 px-2 py-1 text-xs text-amber-950"
                  : "text-xs text-muted-foreground"
              }
            >
              {item.storage === "legacy-public" ? "Legacy public link" : "Cloud stored"}
            </span>
            {item.migrationState === "migrated" ? (
              <span className="text-xs text-muted-foreground">Private copy in Assets</span>
            ) : (
              item.canMigrate && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pendingId !== null}
                  onClick={() => {
                    setPendingId(item.id);
                    setError(null);
                    void client
                      .action(migrateLegacy, { companyId, source, legacyId: item.id })
                      .catch((reason) =>
                        setError(
                          reason instanceof Error
                            ? reason.message
                            : "Migration failed. Original preserved.",
                        ),
                      )
                      .finally(() => setPendingId(null));
                  }}
                >
                  {pendingId === item.id
                    ? "Copying…"
                    : item.storage === "legacy-public"
                      ? "Copy to private Assets"
                      : "Make available across devices"}
                </Button>
              )
            )}
          </li>
        ))}
      </ul>
      {items?.length === 0 && (
        <p className="text-sm text-muted-foreground">No existing uploads found.</p>
      )}
      {next && (
        <Button
          variant="outline"
          onClick={() =>
            void client.query(legacyList, { companyId, source, cursor: next, limit: 50 }).then(
              (page) => {
                setItems((current) => [...(current ?? []), ...page.items]);
                setNext(page.nextCursor);
              },
              (reason) =>
                setError(reason instanceof Error ? reason.message : "Could not load more uploads"),
            )
          }
        >
          Load more
        </Button>
      )}
    </section>
  );
}
