import { fetchEnvironmentItemDetail } from "@spiritdevs/client-runtime/state/threads";
import type {
  EnvironmentId,
  OrchestrationV2ItemDetailField,
  OrchestrationV2TurnItem,
} from "@spiritdevs/contracts";
import { useState } from "react";

import { runtime } from "../../lib/runtime";
import { readPreparedConnection } from "../../state/session";

/** Fetches the complete value of an item field that compact payloads sent as a preview. */
export async function loadItemDetail(
  environmentId: EnvironmentId,
  item: Pick<OrchestrationV2TurnItem, "threadId" | "id">,
  field: OrchestrationV2ItemDetailField,
): Promise<string> {
  const prepared = readPreparedConnection(environmentId);
  if (prepared === null) throw new Error("The environment is disconnected.");
  const detail = await runtime.runPromise(
    fetchEnvironmentItemDetail({
      prepared,
      threadId: item.threadId,
      itemId: item.id,
      ...(field === "output" ? {} : { field }),
    }),
  );
  return detail.text;
}

/**
 * Load state for one previewed field. Owners key the component on the item revision so a
 * newer preview drops text fetched for an older one.
 */
export function useFullItemDetail(load: (() => Promise<string>) | undefined) {
  const [fullText, setFullText] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const expand = async () => {
    if (load === undefined) return;
    setLoading(true);
    setFailed(false);
    try {
      setFullText(await load());
    } catch {
      setFailed(true);
    } finally {
      setLoading(false);
    }
  };
  return { fullText, loading, failed, expand };
}

export function showAllLabel(totalBytes: number) {
  return `Show all ${Math.ceil(totalBytes / 1024)} KB`;
}
