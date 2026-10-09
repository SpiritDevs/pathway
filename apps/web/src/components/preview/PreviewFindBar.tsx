import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

import { previewBridge } from "./previewBridge";

interface Props {
  readonly tabId: string;
  readonly onClose: () => void;
}

/**
 * Find in page for the active preview tab. Rendered as its own row above the
 * page because the guest view paints over anything layered on top of it.
 */
export function PreviewFindBar({ tabId, onClose }: Props) {
  const [text, setText] = useState("");
  const [result, setResult] = useState<{ active: number; matches: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      void previewBridge?.stopFindInPage?.(tabId).catch(() => undefined);
    };
  }, [tabId]);

  const find = (query: string, forward: boolean, findNext: boolean) => {
    if (!previewBridge?.findInPage) return;
    if (query === "") {
      setResult(null);
      void previewBridge.stopFindInPage?.(tabId).catch(() => undefined);
      return;
    }
    void previewBridge
      .findInPage({ tabId, text: query, forward, findNext })
      .then((next) => setResult({ active: next.activeMatchOrdinal, matches: next.matches }))
      .catch(() => setResult(null));
  };

  return (
    <div className="flex h-10 shrink-0 items-center gap-1.5 border-b border-border/70 px-2">
      <Input
        ref={inputRef}
        size="sm"
        className="max-w-64"
        placeholder="Find in page"
        aria-label="Find in page"
        value={text}
        maxLength={1024}
        onChange={(event) => {
          setText(event.target.value);
          find(event.target.value, true, false);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            find(text, !event.shiftKey, true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      />
      <span className="min-w-14 text-xs text-muted-foreground tabular-nums">
        {result ? `${result.matches === 0 ? 0 : result.active}/${result.matches}` : null}
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Previous match"
        disabled={text === ""}
        onClick={() => find(text, false, true)}
      >
        <ChevronUpIcon />
      </Button>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Next match"
        disabled={text === ""}
        onClick={() => find(text, true, true)}
      >
        <ChevronDownIcon />
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label="Close find bar" onClick={onClose}>
        <XIcon />
      </Button>
    </div>
  );
}
