import { useMemo, useState, type ClipboardEventHandler, type RefObject } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { collapseExpandedComposerCursor, shouldSubmitComposerOnEnter } from "../../composer-logic";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useTheme } from "../../hooks/useTheme";
import { ComposerPromptEditor, type ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import { ComposerCommandMenu, type ComposerCommandItem } from "../chat/ComposerCommandMenu";
import { COMPOSER_EDITOR_CLASS_NAME } from "../chat/ComposerSurface";
import { recipientQuery, type ConversationRecipient } from "./conversationRecipients";

const NO_TERMINAL_CONTEXTS: [] = [];
const NO_SKILLS: [] = [];
const ignoreTerminalContext = () => {};

/**
 * The thread composer's editor, addressing a conversation: `@` opens the recipients in the
 * same attached menu threads use for files, and the pick shows as a chip beside the text.
 */
export function ConversationRecipientInput({
  editor,
  menuSlot,
  menuSuppressed,
  text,
  onChange,
  recipients,
  selected,
  onSelect,
  disabled,
  locked,
  title,
  onSend,
  onEscape,
  onPaste,
}: {
  editor: RefObject<ComposerPromptEditorHandle | null>;
  /** The composer surface the `@` menu grows out of. */
  menuSlot: HTMLElement | null;
  /** Another attached menu is open, so the `@` menu stays shut. */
  menuSuppressed: boolean;
  text: string;
  onChange: (text: string) => void;
  recipients: readonly ConversationRecipient[];
  selected: ConversationRecipient | undefined;
  onSelect: (id: string | undefined) => void;
  disabled: boolean;
  locked: boolean;
  title: string;
  onSend: () => void;
  onEscape: (() => void) | undefined;
  onPaste: ClipboardEventHandler<HTMLElement>;
}) {
  const { resolvedTheme } = useTheme();
  const isMobileViewport = useMediaQuery("max-sm");
  const [cursor, setCursor] = useState(() => collapseExpandedComposerCursor(text, text.length));
  const [query, setQuery] = useState<ReturnType<typeof recipientQuery>>(null);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const open =
    !!query &&
    text.slice(query.start, query.end) === "@" + query.query &&
    !disabled &&
    !locked &&
    !menuSuppressed;
  const needle = query?.query.trim().toLocaleLowerCase() ?? "";
  const items = useMemo(
    () =>
      recipients
        .filter((recipient) => recipient.name.toLocaleLowerCase().includes(needle))
        .map(
          (recipient): ComposerCommandItem => ({
            id: recipient.id,
            type: "recipient",
            label: recipient.name,
            description: recipient.recipientType === "user" ? "Person" : "Agent",
          }),
        ),
    [needle, recipients],
  );
  const active = items.find((item) => item.id === highlightedId) ?? items[0];

  const replaceText = (next: string, expandedCursor: number) => {
    const nextCursor = collapseExpandedComposerCursor(next, expandedCursor);
    onChange(next);
    setCursor(nextCursor);
    requestAnimationFrame(() => editor.current?.focusAt(nextCursor));
  };
  const choose = (item: ComposerCommandItem) => {
    if (!query) return;
    replaceText(text.slice(0, query.start) + text.slice(query.end), query.start);
    onSelect(item.id);
    setQuery(null);
  };

  return (
    <div
      className="flex min-w-0 flex-1 flex-wrap items-center gap-1 self-center"
      onBlur={() => setQuery(null)}
      // Escape and Backspace are not editor commands, so they are read on the way down.
      onKeyDownCapture={(event) => {
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Escape" && (open || onEscape)) {
          event.preventDefault();
          event.stopPropagation();
          if (open) setQuery(null);
          else onEscape?.();
          return;
        }
        if (event.key === "Backspace" && !text && selected && !locked) {
          event.preventDefault();
          onSelect(undefined);
        }
      }}
    >
      {selected && !locked && (
        <span className="flex max-w-full items-center rounded-full bg-blue-500/10 pl-2 text-xs text-blue-600">
          <button
            type="button"
            disabled={disabled}
            className="truncate py-1"
            aria-label={`Change recipient ${selected.name}`}
            onClick={() => {
              replaceText("@" + text, 1);
              setQuery({ start: 0, end: 1, query: "" });
              setHighlightedId(null);
            }}
          >
            @{selected.name}
          </button>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={disabled}
            aria-label={`Remove recipient ${selected.name}`}
            onClick={() => {
              onSelect(undefined);
              editor.current?.focus();
            }}
          >
            <XIcon className="size-3" />
          </Button>
        </span>
      )}
      <div className="min-w-24 flex-1" data-conversation-composer-editor="true">
        <ComposerPromptEditor
          editorRef={editor}
          value={text}
          cursor={cursor}
          terminalContexts={NO_TERMINAL_CONTEXTS}
          skills={NO_SKILLS}
          className={COMPOSER_EDITOR_CLASS_NAME}
          disabled={disabled}
          placeholder={`Message ${title}${locked ? "" : " · @ to address"}`}
          onRemoveTerminalContext={ignoreTerminalContext}
          onPaste={onPaste}
          onChange={(value, nextCursor, expandedCursor, cursorAdjacentToMention) => {
            if (value !== text) onChange(value);
            setCursor(nextCursor);
            setQuery(cursorAdjacentToMention ? null : recipientQuery(value, expandedCursor));
          }}
          onCommandKeyDown={(key, event) => {
            if (open) {
              if (key === "ArrowDown" || key === "ArrowUp") {
                if (items.length > 0) {
                  const index = active ? items.indexOf(active) : -1;
                  const offset = key === "ArrowDown" ? 1 : -1;
                  setHighlightedId(items[(index + offset + items.length) % items.length]!.id);
                }
                return true;
              }
              if (!event.shiftKey) {
                if (active) choose(active);
                else setQuery(null);
                return true;
              }
            }
            if (
              key === "Enter" &&
              shouldSubmitComposerOnEnter({ isMobileViewport, shiftKey: event.shiftKey })
            ) {
              onSend();
              return true;
            }
            return false;
          }}
        />
      </div>
      {open &&
        menuSlot &&
        createPortal(
          <ComposerCommandMenu
            items={items}
            resolvedTheme={resolvedTheme}
            isLoading={false}
            triggerKind={null}
            label="Conversation recipients"
            emptyStateText="No matching recipients"
            activeItemId={active?.id ?? null}
            onHighlightedItemChange={setHighlightedId}
            onSelect={choose}
          />,
          menuSlot,
        )}
    </div>
  );
}
