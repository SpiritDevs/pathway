import { useState } from "react";
import { ChartNoAxesCombinedIcon, ExternalLinkIcon } from "lucide-react";
import type { ScopedThreadRef } from "@spiritdevs/contracts";
import { isAtomCommandInterrupted } from "@spiritdevs/client-runtime/state/runtime";

import { useAssetUrlState } from "../assets/assetUrls";
import { openUrlInPreview } from "../browser/openFileInPreview";
import { isPreviewSupportedInRuntime } from "../previewStateStore";
import { previewEnvironment } from "../state/preview";
import { useAtomCommand } from "../state/use-atom-command";

interface Props {
  path: string;
  title: string;
  threadRef?: ScopedThreadRef | undefined;
  onOpen?: (() => void) | undefined;
}

const CARD_CLASS =
  "not-prose flex w-full items-center gap-3 rounded-xl border border-border bg-muted/30 px-4 py-2.5 text-left text-sm";

export function ChatVisualization(props: Props) {
  if (!props.threadRef) {
    return <div className={CARD_CLASS}>Visualization unavailable: thread context is missing.</div>;
  }
  return <ConnectedVisualization {...props} threadRef={props.threadRef} />;
}

function ConnectedVisualization({
  path,
  title,
  threadRef,
  onOpen,
}: Props & { threadRef: ScopedThreadRef }) {
  const asset = useAssetUrlState(threadRef.environmentId, {
    _tag: "visualization-file",
    threadId: threadRef.threadId,
    path,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const [opening, setOpening] = useState(false);
  const [failed, setFailed] = useState(false);
  const label = (
    <>
      <ChartNoAxesCombinedIcon className="size-6 shrink-0 text-primary" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-foreground">{title}</span>
        <span className="block text-xs text-muted-foreground">
          {opening ? "Opening…" : "Open visualization in browser"}
        </span>
      </span>
      <ExternalLinkIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
    </>
  );
  if (asset._tag !== "Success") {
    return (
      <div className={CARD_CLASS}>
        <ChartNoAxesCombinedIcon
          className="size-6 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <div className="min-w-0">
          <div className="truncate font-medium">{title}</div>
          <p className="text-xs text-muted-foreground">
            {asset._tag === "Loading"
              ? "Loading visualization…"
              : "Visualization unavailable. Connect to its environment and check that the file still exists."}
          </p>
          {asset._tag === "Failure" && asset.refresh && (
            <button type="button" className="mt-2 text-xs underline" onClick={asset.refresh}>
              Retry visualization
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="not-prose">
      <a
        href={asset.url}
        target="_blank"
        rel="noopener noreferrer"
        className={`${CARD_CLASS} hover:bg-muted/60 focus-visible:outline-2 focus-visible:outline-ring`}
        aria-label={`Open visualization: ${title}`}
        aria-busy={opening}
        onClick={async (event) => {
          if (
            !isPreviewSupportedInRuntime() ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          event.preventDefault();
          if (opening) return;
          setOpening(true);
          setFailed(false);
          try {
            const result = await openUrlInPreview({ threadRef, url: asset.url, openPreview });
            if (result._tag === "Success") onOpen?.();
            else if (!isAtomCommandInterrupted(result)) setFailed(true);
          } catch {
            setFailed(true);
          } finally {
            setOpening(false);
          }
        }}
      >
        {label}
      </a>
      {failed && (
        <p role="alert" className="mt-2 text-xs text-destructive">
          Couldn’t open the visualization. Click to retry.
        </p>
      )}
    </div>
  );
}
