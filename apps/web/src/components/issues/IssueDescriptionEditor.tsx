import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { CheckListPlugin } from "@lexical/react/LexicalCheckListPlugin";
import { ListPlugin } from "@lexical/react/LexicalListPlugin";
import { MarkdownShortcutPlugin } from "@lexical/react/LexicalMarkdownShortcutPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { RichTextPlugin } from "@lexical/react/LexicalRichTextPlugin";
import {
  LexicalTypeaheadMenuPlugin,
  MenuOption,
  type MenuRenderFn,
  useBasicTypeaheadTriggerMatch,
} from "@lexical/react/LexicalTypeaheadMenuPlugin";
import { $convertFromMarkdownString, $convertToMarkdownString } from "@lexical/markdown";
import {
  Code2Icon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  PilcrowIcon,
  QuoteIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { cn } from "~/lib/utils";
import {
  $applyIssueDescriptionCommand,
  filterIssueDescriptionCommands,
  ISSUE_DESCRIPTION_NODES,
  ISSUE_DESCRIPTION_TRANSFORMERS,
  type IssueDescriptionCommand,
  type IssueDescriptionCommandId,
} from "./issueDescriptionEditor.logic";

const EXTERNAL_DESCRIPTION_SYNC_TAG = "issue-description-external-sync";

const ISSUE_DESCRIPTION_THEME = {
  code: "my-2 block overflow-x-auto whitespace-pre-wrap rounded-md border border-border/70 bg-muted/45 px-3 py-2 font-mono text-xs leading-5",
  heading: {
    h1: "mt-3 mb-1 text-lg font-semibold leading-6 first:mt-0",
    h2: "mt-3 mb-1 text-base font-semibold leading-5 first:mt-0",
    h3: "mt-2 mb-1 text-sm font-semibold leading-5 first:mt-0",
  },
  link: "text-primary underline decoration-primary/40 underline-offset-2",
  list: {
    checklist: "my-1 list-none ps-0",
    listitem: "my-0.5",
    listitemChecked:
      "relative ps-6 text-muted-foreground line-through before:absolute before:start-0 before:top-0.5 before:size-4 before:rounded-[4px] before:border before:border-primary before:bg-primary after:absolute after:start-[5px] after:top-[3px] after:h-2 after:w-1 after:rotate-45 after:border-r-2 after:border-b-2 after:border-primary-foreground",
    listitemUnchecked:
      "relative ps-6 before:absolute before:start-0 before:top-0.5 before:size-4 before:rounded-[4px] before:border before:border-input before:bg-background",
    nested: {
      listitem: "my-0",
    },
    ol: "my-1 list-decimal ps-6",
    ul: "my-1 list-disc ps-6",
  },
  paragraph: "my-0.5 min-h-5 first:mt-0 last:mb-0",
  quote: "my-2 border-s-2 border-border ps-3 text-muted-foreground",
  text: {
    bold: "font-semibold",
    code: "rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]",
    italic: "italic",
    strikethrough: "line-through",
  },
};

function DescriptionCommandIcon({ id }: { id: IssueDescriptionCommandId }) {
  const className = "size-4";
  switch (id) {
    case "paragraph":
      return <PilcrowIcon className={className} />;
    case "heading-1":
      return <Heading1Icon className={className} />;
    case "heading-2":
      return <Heading2Icon className={className} />;
    case "heading-3":
      return <Heading3Icon className={className} />;
    case "bulleted-list":
      return <ListIcon className={className} />;
    case "numbered-list":
      return <ListOrderedIcon className={className} />;
    case "check-list":
      return <ListChecksIcon className={className} />;
    case "code-block":
      return <Code2Icon className={className} />;
    case "blockquote":
      return <QuoteIcon className={className} />;
  }
}

class DescriptionCommandOption extends MenuOption {
  readonly command: IssueDescriptionCommand;

  constructor(command: IssueDescriptionCommand) {
    super(command.id);
    this.command = command;
  }
}

const renderDescriptionCommandMenu: MenuRenderFn<DescriptionCommandOption> = (
  anchorElementRef,
  menu,
) => {
  if (anchorElementRef.current === null) return null;

  return createPortal(
    <div
      aria-label="Description commands"
      className="dropdown-glass w-72 overflow-hidden rounded-xl border border-border/80 p-1 shadow-xl"
      role="listbox"
    >
      {menu.options.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">No matching commands.</p>
      ) : (
        menu.options.map((option, index) => {
          const previous = menu.options[index - 1];
          const startsGroup = index > 0 && previous?.command.group !== option.command.group;
          const active = menu.selectedIndex === index;

          return (
            <div
              className={cn(startsGroup && "mt-1 border-t border-border/70 pt-1")}
              key={option.key}
            >
              <button
                aria-selected={active}
                className={cn(
                  "flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-start outline-none",
                  active && "bg-accent text-accent-foreground",
                )}
                id={`typeahead-item-${index}`}
                onClick={() => menu.selectOptionAndCleanUp(option)}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => menu.setHighlightedIndex(index)}
                ref={option.setRefElement}
                role="option"
                type="button"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted/65 text-muted-foreground">
                  <DescriptionCommandIcon id={option.command.id} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] font-medium leading-4">
                    {option.command.label}
                  </span>
                  <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                    {option.command.description}
                  </span>
                </span>
                <kbd className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {option.command.hint}
                </kbd>
              </button>
            </div>
          );
        })
      )}
    </div>,
    anchorElementRef.current,
  );
};

function DescriptionSlashCommandPlugin() {
  const [query, setQuery] = useState<string | null>(null);
  const triggerMatch = useBasicTypeaheadTriggerMatch("/", { minLength: 0 });
  const options = useMemo(
    () =>
      filterIssueDescriptionCommands(query ?? "").map((item) => new DescriptionCommandOption(item)),
    [query],
  );

  return (
    <LexicalTypeaheadMenuPlugin<DescriptionCommandOption>
      anchorClassName="z-[140]"
      menuRenderFn={renderDescriptionCommandMenu}
      onQueryChange={setQuery}
      onSelectOption={(option, textNodeContainingQuery, closeMenu) => {
        if (!$applyIssueDescriptionCommand(option.command.id)) return;
        textNodeContainingQuery?.remove();
        closeMenu();
      }}
      options={options}
      triggerFn={triggerMatch}
    />
  );
}

function ExternalDescriptionValuePlugin({
  value,
  focused,
  draftRef,
  savedRef,
  lastExternalValueRef,
}: {
  value: string;
  focused: boolean;
  draftRef: React.RefObject<string>;
  savedRef: React.RefObject<string>;
  lastExternalValueRef: React.RefObject<string>;
}) {
  const [editor] = useLexicalComposerContext();

  useLayoutEffect(() => {
    if (lastExternalValueRef.current === value) return;
    if (focused) return;

    lastExternalValueRef.current = value;
    draftRef.current = value;
    savedRef.current = value;
    editor.update(() => $convertFromMarkdownString(value, ISSUE_DESCRIPTION_TRANSFORMERS), {
      tag: EXTERNAL_DESCRIPTION_SYNC_TAG,
    });
  }, [draftRef, editor, focused, lastExternalValueRef, savedRef, value]);

  return null;
}

export function IssueDescriptionEditor({
  value,
  onCommit,
  onPasteImages,
}: {
  value: string;
  onCommit: (next: string) => void;
  onPasteImages: (files: ReadonlyArray<File>) => void;
}) {
  const initialValueRef = useRef(value);
  const draftRef = useRef(value);
  const savedRef = useRef(value);
  const lastExternalValueRef = useRef(value);
  const valueRef = useRef(value);
  const onCommitRef = useRef(onCommit);
  const focusedRef = useRef(false);
  const [focused, setFocused] = useState(false);
  valueRef.current = value;
  onCommitRef.current = onCommit;
  const initialConfig = useMemo<InitialConfigType>(
    () => ({
      namespace: "pathway-issue-description",
      editorState: () =>
        $convertFromMarkdownString(initialValueRef.current, ISSUE_DESCRIPTION_TRANSFORMERS),
      nodes: [...ISSUE_DESCRIPTION_NODES],
      onError: (error) => {
        throw error;
      },
      theme: ISSUE_DESCRIPTION_THEME,
    }),
    [],
  );

  const handleBlur = useCallback(() => {
    focusedRef.current = false;
    setFocused(false);
    const next = draftRef.current;
    if (next === savedRef.current) return;
    lastExternalValueRef.current = valueRef.current;
    savedRef.current = next;
    onCommitRef.current(next);
  }, []);

  useEffect(
    () => () => {
      const next = draftRef.current;
      if (next === savedRef.current) return;
      savedRef.current = next;
      onCommitRef.current(next);
    },
    [],
  );

  return (
    <LexicalComposer initialConfig={initialConfig}>
      <div className="relative rounded-lg border border-transparent bg-transparent text-[13px] text-foreground transition-[border-color,box-shadow] hover:border-input focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/24">
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              aria-label="Issue description"
              aria-multiline="true"
              className="min-h-9 w-full px-3 py-1.5 leading-5 outline-none"
              onBlur={(event) => {
                if (
                  event.relatedTarget instanceof Node &&
                  event.currentTarget.contains(event.relatedTarget)
                ) {
                  return;
                }
                handleBlur();
              }}
              onFocus={() => {
                focusedRef.current = true;
                setFocused(true);
              }}
              onPaste={(event) => {
                const images = [...event.clipboardData.files].filter((file) =>
                  file.type.startsWith("image/"),
                );
                if (images.length === 0) return;
                event.preventDefault();
                onPasteImages(images);
              }}
            />
          }
          placeholder={
            <div className="pointer-events-none absolute inset-x-3 top-1.5 text-[13px] leading-5 text-placeholder">
              Add a description… Type / for commands
            </div>
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <OnChangePlugin
          ignoreSelectionChange
          onChange={(editorState, _editor, tags) => {
            if (tags.has(EXTERNAL_DESCRIPTION_SYNC_TAG)) return;
            editorState.read(() => {
              draftRef.current = $convertToMarkdownString(ISSUE_DESCRIPTION_TRANSFORMERS);
            });
          }}
        />
        <HistoryPlugin />
        <ListPlugin />
        <CheckListPlugin />
        <MarkdownShortcutPlugin transformers={ISSUE_DESCRIPTION_TRANSFORMERS} />
        <ExternalDescriptionValuePlugin
          draftRef={draftRef}
          focused={focused}
          lastExternalValueRef={lastExternalValueRef}
          savedRef={savedRef}
          value={value}
        />
        {focused ? <DescriptionSlashCommandPlugin /> : null}
      </div>
    </LexicalComposer>
  );
}
