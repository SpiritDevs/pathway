import { CornerLeftUpIcon, MessageSquareIcon } from "lucide-react";
import { useLayoutEffect, useRef } from "react";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { Button } from "../ui/button";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { formatSubagentBarStatus, type SubagentBarStatus } from "./SubagentComposerBar.logic";

/**
 * Stands in for the composer on a subagent thread: which model is working,
 * for how long, and a way back to the parent. App-owned subagents can still
 * take messages, so `onMessage` expands the full composer; provider-native
 * subagents are run by their provider and pass null.
 */
export function SubagentComposerBar(props: {
  /** Null while the provider catalog loads. */
  readonly provider: ProviderInstanceEntry | null;
  readonly showInstanceBadge: boolean;
  readonly modelLabel: string;
  readonly effortLabel: string | null;
  /** Null until the subagent's first run or roster record arrives. */
  readonly status: SubagentBarStatus | null;
  readonly onMessage: (() => void) | null;
  readonly messagingAvailable: boolean | null;
  readonly onOpenParent: (() => void) | null;
}) {
  const statusRef = useRef<HTMLSpanElement>(null);
  const { status } = props;
  const live = status?.phase === "working";
  const modelDescription =
    props.effortLabel === null ? props.modelLabel : `${props.modelLabel}, ${props.effortLabel}`;
  // Announced once per transition; the ticking label below is not.
  const announcement = formatSubagentBarStatus(
    status === null ? null : { ...status, startedAt: null },
    0,
  );

  // Written from an effect so a running timer ticks through DOM writes and
  // never re-renders the chat view.
  useLayoutEffect(() => {
    const update = () => {
      if (statusRef.current) {
        statusRef.current.textContent = formatSubagentBarStatus(status, Date.now());
      }
    };
    update();
    if (!live) return;
    const id = setInterval(update, 1_000);
    return () => clearInterval(id);
  }, [live, status]);

  return (
    <div className="rounded-[22px] p-px">
      <div
        data-chat-composer-content-sized="true"
        className="flex min-h-12 items-center gap-3 rounded-[28px] border border-border/60 py-2 ps-5 pe-2 text-sm shadow-sm"
      >
        <span className="flex min-w-0 items-center gap-2">
          {props.provider ? (
            <ProviderInstanceIcon
              driverKind={props.provider.driverKind}
              displayName={props.provider.displayName}
              accentColor={props.provider.accentColor}
              showBadge={props.showInstanceBadge}
              className="size-4 shrink-0"
              iconClassName="size-4"
            />
          ) : null}
          <span className="min-w-0 truncate font-medium text-foreground">{props.modelLabel}</span>
          {props.effortLabel === null ? null : (
            <span className="shrink-0 text-muted-foreground">{props.effortLabel}</span>
          )}
        </span>
        <span
          ref={statusRef}
          aria-hidden
          className="min-w-0 truncate text-muted-foreground tabular-nums"
        />
        <span role="status" className="sr-only">
          {`${modelDescription} subagent: ${announcement}`}
        </span>
        <span className="ms-auto flex shrink-0 items-center gap-1">
          {props.onMessage ? (
            <Button size="sm" variant="ghost" onClick={props.onMessage}>
              <MessageSquareIcon />
              Message
            </Button>
          ) : (
            <span className="pe-2 text-muted-foreground max-sm:hidden">
              {props.messagingAvailable === null ? "Loading subagent" : "Runs on its own"}
            </span>
          )}
          {props.onOpenParent ? (
            <Button size="sm" variant="ghost" onClick={props.onOpenParent}>
              <CornerLeftUpIcon />
              Open parent
            </Button>
          ) : null}
        </span>
      </div>
    </div>
  );
}
