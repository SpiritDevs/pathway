import type { ScopedThreadRef } from "@spiritdevs/contracts";
import { useThreadProjection } from "../../state/entities";

import { BackgroundServiceOutput } from "./BackgroundServiceOutput";

export function ThreadBackgroundOutputPanel({
  threadRef,
  taskId,
}: {
  threadRef: ScopedThreadRef;
  taskId: string;
}) {
  const thread = useThreadProjection(threadRef);
  if (thread === null)
    return <p className="p-4 text-sm text-muted-foreground">Loading service output…</p>;
  const item = thread.projection.turnItems.find(
    (candidate) => (candidate.nativeItemRef?.nativeId ?? candidate.id) === taskId,
  );
  return <BackgroundServiceOutput item={item} />;
}
