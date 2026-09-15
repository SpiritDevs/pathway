import { useId, useLayoutEffect, useRef, useState, type ClipboardEventHandler } from "react";
import { createPortal } from "react-dom";
import { XIcon } from "lucide-react";
import { Button } from "../ui/button";
import { cn } from "../../lib/utils";
import { recipientQuery, type ConversationRecipient } from "./conversationRecipients";

/** Like the skills menu, the recipient menu leaves keyboard focus in the editor. */
export function ConversationRecipientInput({
  input,
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
  input: React.RefObject<HTMLTextAreaElement | null>;
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
  onPaste: ClipboardEventHandler<HTMLTextAreaElement>;
}) {
  const id = useId();
  const anchor = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState<ReturnType<typeof recipientQuery>>(null);
  const [highlight, setHighlight] = useState(0);
  const [position, setPosition] = useState<{
    left: number;
    bottom: number;
    width: number;
    maxHeight: number;
  }>();
  const open =
    !!query && text.slice(query.start, query.end) === "@" + query.query && !disabled && !locked;
  const matches = recipients.filter((c) =>
    c.name.toLocaleLowerCase().includes(query?.query.trim().toLocaleLowerCase() ?? ""),
  );
  const active = Math.min(highlight, Math.max(0, matches.length - 1));
  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const element = anchor.current;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setPosition({
        left: rect.left,
        bottom: window.innerHeight - rect.top + 8,
        width: rect.width,
        maxHeight: Math.max(80, rect.top - 16),
      });
    };
    update();
    const observer = new ResizeObserver(update);
    for (let el: HTMLElement | null = element; el; el = el.parentElement) observer.observe(el);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);
  useLayoutEffect(() => {
    menu.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active, query]);
  const choose = (recipient: ConversationRecipient) => {
    if (!query) return;
    onChange(text.slice(0, query.start) + text.slice(query.end));
    onSelect(recipient.id);
    setQuery(null);
    const caret = query.start;
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.setSelectionRange(caret, caret);
    });
  };
  return (
    <div ref={anchor} className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
      {selected && !locked && (
        <span className="flex max-w-full items-center rounded-full bg-blue-500/10 pl-2 text-xs text-blue-600">
          <button
            type="button"
            disabled={disabled}
            className="truncate py-1"
            aria-label={`Change recipient ${selected.name}`}
            onClick={() => {
              input.current?.focus();
              onChange("@" + text);
              setQuery({ start: 0, end: 1, query: "" });
              setHighlight(0);
              requestAnimationFrame(() => input.current?.setSelectionRange(1, 1));
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
              input.current?.focus();
            }}
          >
            <XIcon className="size-3" />
          </Button>
        </span>
      )}
      <textarea
        ref={input}
        aria-label={`Message ${title}`}
        placeholder={`Message ${title}${locked ? "" : " · @ to address"}`}
        aria-autocomplete="list"
        aria-controls={open ? id : undefined}
        aria-expanded={open}
        aria-activedescendant={open && matches.length ? `${id}-${active}` : undefined}
        className="field-sizing-content max-h-40 min-h-9 min-w-24 flex-1 resize-none bg-transparent py-2 text-sm leading-5 outline-none placeholder:text-muted-foreground"
        rows={1}
        value={text}
        maxLength={32000}
        disabled={disabled}
        onPaste={onPaste}
        onChange={(event) => {
          onChange(event.target.value);
          setQuery(recipientQuery(event.target.value, event.target.selectionStart));
          setHighlight(0);
        }}
        onClick={(event) => {
          const el = event.currentTarget;
          setQuery(
            el.selectionStart === el.selectionEnd ? recipientQuery(text, el.selectionStart) : null,
          );
          setHighlight(0);
        }}
        onBlur={() => setQuery(null)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (open) {
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              event.stopPropagation();
              setHighlight(
                matches.length
                  ? (active + (event.key === "ArrowDown" ? 1 : -1) + matches.length) %
                      matches.length
                  : 0,
              );
              return;
            }
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              setQuery(null);
              return;
            }
            if (
              (event.key === "Tab" && !event.shiftKey) ||
              (event.key === "Enter" && !event.shiftKey)
            ) {
              event.preventDefault();
              event.stopPropagation();
              if (matches[active]) choose(matches[active]);
              else setQuery(null);
              return;
            }
            if (["ArrowLeft", "ArrowRight", "Home", "End", "Tab"].includes(event.key))
              setQuery(null);
          }
          if (event.key === "Backspace" && !text && selected && !locked) {
            event.preventDefault();
            onSelect(undefined);
            return;
          }
          if (event.key === "Escape" && onEscape) {
            event.preventDefault();
            event.stopPropagation();
            onEscape();
            return;
          }
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSend();
          }
        }}
      />
      {open &&
        position &&
        createPortal(
          <div
            ref={menu}
            style={position}
            className="dropdown-glass fixed z-[150] overflow-auto rounded-[20px] border bg-popover p-2 text-popover-foreground shadow-lg"
            onMouseDown={(e) => e.preventDefault()}
          >
            <p className="px-3 py-1 text-xs text-muted-foreground">
              Recipients · ↑↓ to browse · Tab to select
            </p>
            <div id={id} role="listbox" aria-label="Conversation recipients">
              {matches.map((contact, index) => (
                <div
                  key={contact.id}
                  id={`${id}-${index}`}
                  role="option"
                  aria-selected={index === active}
                  className={cn(
                    "cursor-pointer rounded-lg px-3 py-2 text-sm",
                    index === active && "bg-accent text-accent-foreground",
                  )}
                  onMouseMove={() => setHighlight(index)}
                  onClick={() => choose(contact)}
                >
                  {contact.name}
                </div>
              ))}
            </div>
            {!matches.length && (
              <p role="status" className="px-3 py-3 text-sm text-muted-foreground">
                No matching recipients
              </p>
            )}
          </div>,
          document.body,
        )}
    </div>
  );
}
