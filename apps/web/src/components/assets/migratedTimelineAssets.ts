import type { Asset } from "@spiritdevs/contracts/assets";
import type { TimelineEntry } from "../../session-logic";

export function applyMigratedTimelineAssets(
  entries: ReadonlyArray<TimelineEntry>,
  companyId: string,
  aliases: ReadonlyMap<string, Asset | null>,
): ReadonlyArray<TimelineEntry> {
  return entries.map((entry) => {
    if (entry.kind !== "message" || !entry.message.attachments) return entry;
    let changed = false;
    const attachments = entry.message.attachments.map((attachment) => {
      const asset = aliases.get(attachment.id);
      if (!asset || asset.companyId !== companyId || attachment.type === "asset") return attachment;
      changed = true;
      return {
        type: "asset" as const,
        id: attachment.id,
        assetId: asset.id,
        companyId: asset.companyId,
        name: asset.name,
        mimeType: asset.mimeType,
        sizeBytes: asset.byteSize,
      };
    });
    return changed ? { ...entry, message: { ...entry.message, attachments } } : entry;
  });
}
