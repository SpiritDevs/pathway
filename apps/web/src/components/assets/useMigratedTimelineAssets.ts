import { applyMigratedTimelineAssets } from "./migratedTimelineAssets";
import type { Asset } from "@spiritdevs/contracts/assets";
import { useEffect, useMemo, useState } from "react";
import { assetFunctions, useAssetClient } from "../../cloud/assetClient";
import type { TimelineEntry } from "../../session-logic";

/** Historical IDs remain intact; only an authorized migration alias replaces their media. */
export function useMigratedTimelineAssets(
  entries: ReadonlyArray<TimelineEntry>,
  companyId: string | null | undefined,
) {
  const client = useAssetClient();
  const idsKey = JSON.stringify(
    [
      ...new Set(
        entries.flatMap((entry) =>
          entry.kind === "message"
            ? (entry.message.attachments ?? [])
                .filter((attachment) => attachment.type !== "asset")
                .map((attachment) => attachment.id)
            : [],
        ),
      ),
    ].sort(),
  );
  const [aliases, setAliases] = useState<{ companyId: string; values: Map<string, Asset | null> }>({
    companyId: "",
    values: new Map(),
  });
  useEffect(() => {
    if (!client || !companyId) return;
    setAliases({ companyId, values: new Map() });
    const ids = JSON.parse(idsKey) as string[];
    const stops = ids.map((legacyId) =>
      client.onUpdate(
        assetFunctions.resolveLegacy,
        { companyId, source: "queue", legacyId },
        (asset) => {
          setAliases((current) => ({
            companyId,
            values: new Map(current.companyId === companyId ? current.values : []).set(
              legacyId,
              asset,
            ),
          }));
        },
        () => {
          // A migration lookup failure never grants access to a private copy.
          setAliases((current) => ({
            companyId,
            values: new Map(current.companyId === companyId ? current.values : []).set(
              legacyId,
              null,
            ),
          }));
        },
      ),
    );
    return () => stops.forEach((stop) => stop());
  }, [client, companyId, idsKey]);
  return useMemo(
    () =>
      client && companyId && aliases.companyId === companyId
        ? applyMigratedTimelineAssets(entries, companyId, aliases.values)
        : entries,
    [entries, aliases, companyId, client],
  );
}
