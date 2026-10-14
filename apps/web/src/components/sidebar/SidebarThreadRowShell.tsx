import type { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ResolvedKeybindingsConfig } from "@spiritdevs/contracts";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
} from "react";

import { useNearViewport } from "../../hooks/useNearViewport";
import { resolveShortcutCommand } from "../../keybindings";
import { cn } from "../../lib/utils";

// Subset of useSortable applied to a card's root <li> (pinned and active
// sections). Listeners go on the whole card (no dedicated handle): the
// pointer sensor's distance constraint keeps plain clicks working, and we
// skip dnd-kit's aria attributes since there is no keyboard sensor and the
// card body already carries its own button semantics.
export type SortableThreadRowBag = Pick<
  ReturnType<typeof useSortable>,
  "listeners" | "setNodeRef" | "transform" | "transition" | "isDragging"
>;

// Popups the body portals out (details card, snooze menu) are still React children of the row, so
// their events bubble here. Only presses inside the row's own DOM count as presses on the row.
function pressedRow(event: ReactMouseEvent<HTMLElement>): boolean {
  return event.currentTarget.contains(event.target as Node);
}

/**
 * One sidebar thread row. Its <li> (observer, sortable node) and its primary element, a
 * `role="button"` that owns click, Enter/Space activation and the context menu, are the same DOM
 * nodes whether or not the body is mounted. A press, focus or activation that starts while the row
 * is far offscreen therefore lands on the same element after the body mounts inside it.
 *
 * The body (`children`, given whether the row is near the viewport) mounts only near the viewport,
 * for the first screenful, the open thread, a row being renamed or dragged, while its details card
 * is open, and while focus is inside the body or its popups. Until then the primary element holds
 * just the thread title with no subscriptions. The <li> carries the row's height in rem, so both
 * states take the same space at any interface font size. Focusing a bodiless row mounts nothing:
 * the browser scrolls focus into view and the body follows the viewport. On the focused row, the
 * `sidebar.threadDetails` binding (I by default, `when: sidebarThreadFocus`) asks for the details
 * card (`onShowDetails`), the keyboard path to what hover shows. Any other binding on that key,
 * such as a user's global `i`, wins by the usual last-rule-wins order and is left to its handler.
 */
export function SidebarThreadRowShell(props: {
  variant: "card" | "slim";
  title: string;
  active: boolean;
  renaming: boolean;
  detailsOpen: boolean;
  keybindings: ResolvedKeybindingsConfig;
  /** `aria-keyshortcuts` for the details binding, or null when nothing binds it. */
  detailsKeyShortcuts: string | null;
  primaryRef?: Ref<HTMLDivElement> | undefined;
  deferRendering: boolean;
  sortable?: SortableThreadRowBag | undefined;
  onClick: (event: ReactMouseEvent) => void;
  onDoubleClick: (event: ReactMouseEvent) => void;
  onActivate: () => void;
  onContextMenu: (position: { x: number; y: number }) => void;
  onShowDetails: () => void;
  children: (near: boolean) => ReactNode;
}) {
  const { sortable } = props;
  const viewport = useNearViewport();
  const rowRef = useCallback(
    (node: HTMLLIElement | null) => {
      sortable?.setNodeRef(node);
      const stopObserving = viewport.ref(node);
      if (node === null) return;
      return () => {
        stopObserving?.();
        sortable?.setNodeRef(null);
      };
    },
    [sortable?.setNodeRef, viewport.ref],
  );
  // React focus events bubble through portals, so this also covers the body's popovers and menus.
  // Blur clears on the next task, after a focus move inside the row has re-claimed it.
  const [focusWithinBody, setFocusWithinBody] = useState(false);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(blurTimer.current), []);
  const rendered =
    viewport.near ||
    focusWithinBody ||
    !props.deferRendering ||
    props.active ||
    props.renaming ||
    props.detailsOpen ||
    sortable?.isDragging;
  const card = props.variant === "card";
  return (
    <li
      ref={rowRef}
      data-thread-item
      data-active-thread={props.active || undefined}
      style={
        card && sortable
          ? {
              transform: CSS.Translate.toString(sortable.transform),
              transition: sortable.transition,
            }
          : undefined
      }
      {...(card ? sortable?.listeners : {})}
      className={cn(
        "relative -ml-[3px] list-none pl-[3px]",
        card ? "h-[5.125rem] py-0.5" : "h-9",
        card && sortable?.isDragging && "z-20 opacity-80",
      )}
    >
      <div
        ref={props.primaryRef}
        role="button"
        tabIndex={0}
        data-testid={card ? "sidebar-row-card" : "sidebar-row-slim"}
        aria-keyshortcuts={props.detailsKeyShortcuts ?? undefined}
        className="group/sidebar-row block size-full cursor-pointer text-left outline-none select-none"
        onFocus={(event) => {
          clearTimeout(blurTimer.current);
          // The primary element survives the body unmounting; only focus inside the body pins it.
          setFocusWithinBody(event.target !== event.currentTarget);
        }}
        onBlur={() => {
          blurTimer.current = setTimeout(() => setFocusWithinBody(false));
        }}
        onClick={(event) => {
          if (pressedRow(event)) props.onClick(event);
        }}
        onDoubleClick={(event) => {
          if (pressedRow(event)) props.onDoubleClick(event);
        }}
        onContextMenu={(event) => {
          if (!pressedRow(event)) return;
          event.preventDefault();
          props.onContextMenu({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          // Keyboard equivalent of right-click: the row has no visible actions button.
          if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
            event.preventDefault();
            const bounds = event.currentTarget.getBoundingClientRect();
            props.onContextMenu({ x: bounds.left, y: bounds.bottom });
            return;
          }
          if (
            !event.defaultPrevented &&
            resolveShortcutCommand(event, props.keybindings, {
              context: { sidebarThreadFocus: true },
            }) === "sidebar.threadDetails"
          ) {
            event.preventDefault();
            props.onShowDetails();
            return;
          }
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          props.onActivate();
        }}
      >
        {rendered ? props.children(viewport.near) : <span className="sr-only">{props.title}</span>}
      </div>
    </li>
  );
}
