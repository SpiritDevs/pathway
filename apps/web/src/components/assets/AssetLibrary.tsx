import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../ui/menu";
import { LegacyAssetInventory } from "./LegacyAssetInventory";
import type { ConvexClient } from "convex/browser";
import { AssetAttachDialog } from "./AssetAttachDialog";
import { newCommandId } from "../../lib/utils";
import type { Asset, AssetKind, AssetPage } from "@spiritdevs/contracts/assets";
import { useEffect, useMemo, useState } from "react";
import {
  PaperclipIcon,
  UploadIcon,
  MoreHorizontalIcon,
  FileIcon,
  ImageIcon,
  FilmIcon,
  MusicIcon,
  DownloadIcon,
} from "lucide-react";
import { assetFunctions, uploadAsset, useAssetClient } from "../../cloud/assetClient";
import { AssetGallery, AssetMedia } from "./AssetMedia";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogTitle,
  DialogHeader,
  DialogPanel,
  DialogFooter,
} from "../ui/dialog";

const bytes = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MB`;
type AssetLibraryProps = {
  companyId: string;
  threadId?: string;
  environmentId?: string;
  compact?: boolean;
};
export function AssetLibrary(props: AssetLibraryProps) {
  const client = useAssetClient();
  return <AssetLibraryContent {...props} client={client} />;
}

/** Real UI with an explicit transport so isolated reviews do not need an app session. */
export function AssetLibraryContent({
  companyId,
  threadId,
  environmentId,
  compact = false,
  client,
}: AssetLibraryProps & { client: ConvexClient | null }) {
  const [page, setPage] = useState<AssetPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [kind, setKind] = useState<AssetKind | "">("");
  const [quotaOpen, setQuotaOpen] = useState(false);
  const [quotaMB, setQuotaMB] = useState(10240);
  const [fileMB, setFileMB] = useState(250);
  const [legacy, setLegacy] = useState(false);
  const [trashed, setTrashed] = useState(false);
  const [uploader, setUploader] = useState("");
  const [since, setSince] = useState("");
  const [sort, setSort] = useState<"newest" | "name" | "size">("newest");
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<Asset | null>(null);
  const [name, setName] = useState("");
  const [deleting, setDeleting] = useState<Asset[]>([]);
  const [sharing, setSharing] = useState<Asset | null>(null);
  const [shareDays, setShareDays] = useState(7);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [gallery, setGallery] = useState<string | null>(null);
  const [attaching, setAttaching] = useState<Asset | null>(null);
  const [details, setDetails] = useState<Asset | null>(null);
  const [pending, setPending] = useState(false);
  const [upload, setUpload] = useState<{
    file: File;
    id: string;
    status: string;
    failed: boolean;
  } | null>(null);
  const args = useMemo(
    () => ({
      companyId,
      ...(threadId ? { threadId } : {}),
      ...(environmentId ? { environmentId } : {}),
      ...(search ? { search } : {}),
      ...(kind ? { kind } : {}),
      trashed,
      ...(uploader ? { uploaderId: uploader } : {}),
      ...(since ? { createdAfter: new Date(since).getTime() } : {}),
      sort,
      limit: 50,
    }),
    [companyId, threadId, environmentId, search, kind, trashed, uploader, since, sort],
  );
  useEffect(() => {
    setPage(null);
    setSelected([]);
    setError(null);
    if (!client) return;
    return client.onUpdate(assetFunctions.list, args, setPage, (reason) =>
      setError(reason.message),
    );
  }, [client, args]);
  const run = async (action: () => Promise<unknown>) => {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Asset action failed");
    } finally {
      setPending(false);
    }
  };
  const beginUpload = async (file: File, id: string = newCommandId()) => {
    if (!client) return;
    setUpload({ file, id, status: "Preparing upload", failed: false });
    try {
      const result = await uploadAsset(
        client,
        {
          companyId,
          file,
          clientRequestId: id,
          ...(threadId
            ? {
                context: {
                  kind: "thread",
                  id: threadId,
                  ...(environmentId ? { environmentId } : {}),
                },
              }
            : {}),
        },
        (status) => setUpload({ file, id, status, failed: false }),
      );
      setUpload({
        file,
        id,
        status: result.previewState === "pending" ? "Uploaded. Preparing preview." : "Uploaded",
        failed: false,
      });
    } catch (reason) {
      setUpload({
        file,
        id,
        status: reason instanceof Error ? reason.message : "Upload failed",
        failed: true,
      });
    }
  };
  const items = page?.items ?? [];
  const shareAsset = items.find((item) => item.id === sharing?.id) ?? sharing;
  const detailAsset = items.find((item) => item.id === details?.id) ?? details;
  if (compact && (!page || page.items.length === 0)) return null;
  return (
    <section className={compact ? "border-t p-3" : "space-y-4"} aria-label="Assets">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 font-medium">
          <PaperclipIcon className="size-4" />
          Assets{compact && ` (${page?.items.length ?? 0})`}
        </h2>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm">
          <UploadIcon className="size-4" />
          Upload
          <input
            type="file"
            className="sr-only"
            disabled={
              !client ||
              (upload !== null &&
                !upload.failed &&
                upload.status !== "Uploaded" &&
                !upload.status.startsWith("Uploaded."))
            }
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file) void beginUpload(file);
              event.currentTarget.value = "";
            }}
          />
        </label>
      </div>
      {!compact && (
        <>
          <p className="text-sm text-muted-foreground">
            Files shared in Pathway. Standalone uploads are private to you and company admins until
            attached elsewhere.
          </p>
          {page && (
            <div className="space-y-1 text-xs text-muted-foreground">
              <div
                role="progressbar"
                aria-label="Company storage used"
                aria-valuemin={0}
                aria-valuemax={page.usage.maxBytes}
                aria-valuenow={page.usage.usedBytes + page.usage.reservedBytes}
                className="h-1.5 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full rounded-full bg-primary"
                  style={{
                    width: `${Math.min(100, ((page.usage.usedBytes + page.usage.reservedBytes) / page.usage.maxBytes) * 100)}%`,
                  }}
                />
              </div>
              <p>
                {bytes(page.usage.usedBytes)} used of {bytes(page.usage.maxBytes)} ·{" "}
                {bytes(page.usage.maxFileBytes)} per file
              </p>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Input
              aria-label="Search assets"
              placeholder="Search files"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="min-w-40 flex-1"
            />
            <select
              aria-label="File type"
              className="rounded-md border bg-background p-2 text-sm"
              value={kind}
              onChange={(event) => setKind(event.target.value as AssetKind | "")}
            >
              <option value="">All types</option>
              {["image", "video", "audio", "document", "file"].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <select
              aria-label="Uploaded by"
              className="rounded-md border bg-background p-2 text-sm"
              value={uploader}
              onChange={(event) => setUploader(event.target.value)}
            >
              <option value="">All uploaders</option>
              {Array.from(new Set(page?.items.map((item) => item.uploaderId))).map((id) => (
                <option key={id}>{id}</option>
              ))}
            </select>
            <input
              aria-label="Uploaded since"
              type="date"
              value={since}
              onChange={(event) => setSince(event.target.value)}
              className="rounded-md border bg-background px-2 text-sm"
            />
            <select
              aria-label="Sort assets"
              className="rounded-md border bg-background p-2 text-sm"
              value={sort}
              onChange={(event) => setSort(event.target.value as "newest" | "name" | "size")}
            >
              <option value="newest">Newest</option>
              <option value="name">Name</option>
              <option value="size">Largest</option>
            </select>
            <Button
              variant={trashed ? "default" : "outline"}
              onClick={() => setTrashed((value) => !value)}
            >
              Trash
            </Button>
          </div>
        </>
      )}
      {!compact && page?.canConfigureQuota && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setQuotaMB(page.usage.maxBytes / 1024 / 1024);
            setFileMB(page.usage.maxFileBytes / 1024 / 1024);
            setQuotaOpen(true);
          }}
        >
          Storage limits
        </Button>
      )}
      {!compact && (
        <Button
          variant={legacy ? "default" : "outline"}
          onClick={() => setLegacy((value) => !value)}
        >
          Existing uploads
        </Button>
      )}
      {legacy && client && <LegacyAssetInventory companyId={companyId} client={client} />}
      {upload && (
        <div role="status" className="rounded-lg border p-3 text-sm">
          {upload.file.name}: {upload.status}
          {upload.failed && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void beginUpload(upload.file, upload.id)}
            >
              Retry upload
            </Button>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      {!client ? (
        <p className="text-sm text-muted-foreground">Connect to Pathway Cloud to manage assets.</p>
      ) : !page && !error ? (
        <p role="status">Loading assets…</p>
      ) : items.length === 0 ? (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {trashed ? "Trash is empty." : "No assets found."}
        </p>
      ) : null}
      {selected.length > 0 && (
        <div className="flex items-center gap-3 text-sm">
          <span>{selected.length} selected</span>
          <Button
            size="sm"
            disabled={pending}
            onClick={() =>
              trashed
                ? void run(async () => {
                    for (const assetId of selected)
                      await client?.mutation(assetFunctions.restore, { companyId, assetId });
                    setSelected([]);
                  })
                : setDeleting(items.filter((item) => selected.includes(item.id)))
            }
          >
            {trashed ? "Restore" : "Delete assets"}
          </Button>
        </div>
      )}
      <ul className="divide-y overflow-hidden rounded-xl border bg-background">
        {items.map((asset) => (
          <li key={asset.id} className="flex items-center gap-3 px-3 py-3">
            {!compact && asset.permissions.canManage && (
              <input
                type="checkbox"
                className="size-3.5 accent-primary"
                aria-label={`Select ${asset.name}`}
                checked={selected.includes(asset.id)}
                onChange={(event) =>
                  setSelected((values) =>
                    event.target.checked
                      ? [...values, asset.id]
                      : values.filter((id) => id !== asset.id),
                  )
                }
              />
            )}
            <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
              {asset.kind === "image" ? (
                <ImageIcon className="size-4" />
              ) : asset.kind === "video" ? (
                <FilmIcon className="size-4" />
              ) : asset.kind === "audio" ? (
                <MusicIcon className="size-4" />
              ) : (
                <FileIcon className="size-4" />
              )}
            </span>
            <button
              type="button"
              className="min-w-0 flex-1 text-left"
              onClick={() => setDetails(asset)}
            >
              <span className="block truncate text-sm font-medium">{asset.name}</span>
              <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                {bytes(asset.byteSize)} ·{" "}
                {asset.state === "preparing"
                  ? "Preparing preview"
                  : asset.state === "trashed"
                    ? "In Trash"
                    : new Date(asset.createdAt).toLocaleDateString()}
                {asset.keepInLibrary ? " · Kept" : ""}
              </span>
            </button>
            <Button size="sm" variant="ghost" onClick={() => setDetails(asset)}>
              View
            </Button>
            {asset.originalReady && !trashed && (
              <Button
                size="icon"
                variant="ghost"
                aria-label={`Download ${asset.name}`}
                disabled={pending}
                onClick={() =>
                  void run(async () => {
                    const result = await client!.mutation(assetFunctions.resolve, {
                      companyId,
                      assetId: asset.id,
                      representation: "original",
                    });
                    const anchor = document.createElement("a");
                    anchor.href = result.url;
                    anchor.download = asset.name;
                    anchor.click();
                  })
                }
              >
                <DownloadIcon className="size-4" />
              </Button>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button size="icon" variant="ghost" aria-label={`Actions for ${asset.name}`} />
                }
              >
                <MoreHorizontalIcon className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {asset.permissions.canManage && !trashed && (
                  <DropdownMenuItem
                    onClick={() => {
                      setEditing(asset);
                      setName(asset.name);
                    }}
                  >
                    Rename
                  </DropdownMenuItem>
                )}
                {asset.permissions.canManage && !trashed && (
                  <DropdownMenuItem
                    disabled={pending}
                    onClick={() =>
                      void run(() =>
                        client!.mutation(assetFunctions.keep, {
                          companyId,
                          assetId: asset.id,
                          keep: !asset.keepInLibrary,
                        }),
                      )
                    }
                  >
                    {asset.keepInLibrary ? "Stop keeping in Assets" : "Keep in Assets"}
                  </DropdownMenuItem>
                )}
                {!trashed && (
                  <DropdownMenuItem onClick={() => setAttaching(asset)}>
                    Attach to thread…
                  </DropdownMenuItem>
                )}
                {asset.permissions.canShare && !trashed && (
                  <DropdownMenuItem
                    onClick={() => {
                      setSharing(asset);
                      setShareUrl(null);
                    }}
                  >
                    Share…
                  </DropdownMenuItem>
                )}
                {threadId && asset.permissions.canManage && !trashed && (
                  <DropdownMenuItem
                    disabled={pending}
                    onClick={() =>
                      void run(() =>
                        client!.mutation(assetFunctions.detach, {
                          companyId,
                          assetId: asset.id,
                          context: {
                            kind: "thread",
                            id: threadId,
                            ...(environmentId ? { environmentId } : {}),
                          },
                        }),
                      )
                    }
                  >
                    Remove from thread
                  </DropdownMenuItem>
                )}
                {asset.permissions.canManage && asset.previewState === "failed" && !trashed && (
                  <DropdownMenuItem
                    disabled={pending}
                    onClick={() =>
                      void run(() =>
                        client!.mutation(assetFunctions.retryProcessing, {
                          companyId,
                          assetId: asset.id,
                        }),
                      )
                    }
                  >
                    Retry preview
                  </DropdownMenuItem>
                )}
                {asset.permissions.canManage &&
                  (trashed ? (
                    <DropdownMenuItem
                      disabled={pending}
                      onClick={() =>
                        void run(() =>
                          client!.mutation(assetFunctions.restore, {
                            companyId,
                            assetId: asset.id,
                          }),
                        )
                      }
                    >
                      Restore
                    </DropdownMenuItem>
                  ) : (
                    <DropdownMenuItem
                      className="text-destructive"
                      onClick={() => setDeleting([asset])}
                    >
                      Delete asset…
                    </DropdownMenuItem>
                  ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        ))}
      </ul>
      {page?.nextCursor && (
        <Button
          variant="outline"
          disabled={pending}
          onClick={() =>
            void run(async () => {
              const next = await client!.query(assetFunctions.list, {
                ...args,
                cursor: page.nextCursor!,
              });
              setPage((current) =>
                current ? { ...next, items: [...current.items, ...next.items] } : next,
              );
            })
          }
        >
          Load more
        </Button>
      )}
      <Dialog open={quotaOpen} onOpenChange={setQuotaOpen}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Company storage limits</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <div className="space-y-3">
              <label className="block text-sm">
                Company limit (MB)
                <Input
                  type="number"
                  min={1}
                  value={quotaMB}
                  onChange={(event) => setQuotaMB(Number(event.target.value))}
                />
              </label>
              <label className="block text-sm">
                Maximum file size (MB)
                <Input
                  type="number"
                  min={1}
                  max={250}
                  value={fileMB}
                  onChange={(event) => setFileMB(Number(event.target.value))}
                />
              </label>
              <p className="text-xs text-muted-foreground">
                Existing files are preserved. Limits cannot be reduced below stored and reserved
                bytes.
              </p>
            </div>
          </DialogPanel>
          <DialogFooter>
            <Button
              disabled={pending || fileMB <= 0 || fileMB > 250 || quotaMB < fileMB}
              onClick={() =>
                void run(async () => {
                  await client!.mutation(assetFunctions.configureQuota, {
                    companyId,
                    maxBytes: Math.round(quotaMB * 1024 * 1024),
                    maxFileBytes: Math.round(fileMB * 1024 * 1024),
                  });
                  setQuotaOpen(false);
                })
              }
            >
              Save limits
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Rename asset</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <Input
              aria-label="Asset name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </DialogPanel>
          <DialogFooter>
            <Button
              disabled={pending || !name.trim()}
              onClick={() =>
                void run(async () => {
                  await client!.mutation(assetFunctions.rename, {
                    companyId,
                    assetId: editing!.id,
                    name: name.trim(),
                  });
                  setEditing(null);
                })
              }
            >
              Save
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={deleting.length > 0}
        onOpenChange={(open) => {
          if (!open) setDeleting([]);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              Move {deleting.length} asset{deleting.length === 1 ? "" : "s"} to Trash?
            </DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <p className="text-sm">
              These files will be unavailable in their messages. Share links stop working
              immediately. You can restore the files for 30 days.
            </p>
            <ul className="mt-3 text-sm">
              {deleting.map((asset) => (
                <li key={asset.id}>
                  {asset.name} · {asset.contexts.length} visible usage
                  {asset.contexts.length === 1 ? "" : "s"}
                </li>
              ))}
            </ul>
          </DialogPanel>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting([])}>
              Cancel
            </Button>
            <Button
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  for (const asset of deleting)
                    await client!.mutation(assetFunctions.trash, { companyId, assetId: asset.id });
                  setDeleting([]);
                  setSelected([]);
                })
              }
            >
              Move to Trash
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={sharing !== null}
        onOpenChange={(open) => {
          if (!open) setSharing(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Share outside Pathway</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <p className="mb-3 text-sm">
              Anyone with the link can open this file until it expires or you revoke it.
            </p>
            <label className="text-sm">
              Expires in days{" "}
              <input
                type="number"
                min={1}
                max={30}
                value={shareDays}
                onChange={(event) => setShareDays(Number(event.target.value))}
                className="ml-2 w-20 rounded border p-2"
              />
            </label>
            <ul className="my-3 space-y-2 text-sm">
              {shareAsset?.shares?.map((share) => (
                <li key={share.id} className="flex items-center justify-between gap-2">
                  <span>
                    {share.revokedAt
                      ? "Revoked"
                      : `Expires ${new Date(share.expiresAt).toLocaleDateString()}`}
                  </span>
                  {!share.revokedAt && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pending}
                      onClick={() =>
                        void run(async () => {
                          await client!.mutation(assetFunctions.revokeShare, {
                            companyId,
                            assetId: shareAsset.id,
                            shareId: share.id,
                          });
                          setShareUrl(null);
                        })
                      }
                    >
                      Revoke
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {shareUrl && (
              <Input
                aria-label="Share link"
                readOnly
                value={shareUrl}
                onFocus={(event) => event.target.select()}
              />
            )}
          </DialogPanel>
          <DialogFooter>
            <Button
              disabled={pending}
              onClick={() =>
                void run(async () => {
                  const result = await client!.mutation(assetFunctions.share, {
                    companyId,
                    assetId: sharing!.id,
                    expiresInDays: shareDays,
                  });
                  setShareUrl(result.url);
                })
              }
            >
              Create share link
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={details !== null}
        onOpenChange={(open) => {
          if (!open) setDetails(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{details?.name}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            {details && client && (
              <>
                <AssetMedia
                  asset={detailAsset ?? details}
                  client={client}
                  onGallery={() => {
                    setGallery(details.id);
                    setDetails(null);
                  }}
                />
                <h3 className="mt-4 text-sm font-medium">Used in</h3>
                <ul className="mt-2 text-xs text-muted-foreground">
                  {details.contexts.map((context) => (
                    <li
                      key={`${context.kind}:${context.environmentId ?? ""}:${context.id}:${context.messageId ?? ""}`}
                    >
                      {context.kind} · {context.title ?? context.id}
                    </li>
                  ))}
                </ul>
                {details.contexts.length === 0 && (
                  <p className="text-sm text-muted-foreground">Standalone library upload</p>
                )}
              </>
            )}
          </DialogPanel>
        </DialogPopup>
      </Dialog>
      {attaching && client && (
        <AssetAttachDialog asset={attaching} client={client} onClose={() => setAttaching(null)} />
      )}
      {gallery && client && (
        <AssetGallery
          assets={page?.items ?? []}
          selectedId={gallery}
          client={client}
          {...(page?.nextCursor
            ? {
                onLoadMore: async () => {
                  const next = await client.query(assetFunctions.list, {
                    ...args,
                    cursor: page.nextCursor!,
                  });
                  setPage((current) =>
                    current ? { ...next, items: [...current.items, ...next.items] } : next,
                  );
                },
              }
            : {})}
          onClose={() => setGallery(null)}
        />
      )}
    </section>
  );
}
