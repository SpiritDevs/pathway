import type { ComponentProps, ReactNode } from "react";
import { cn } from "~/lib/utils";

/** The input row's padding inside a composer surface. */
export const COMPOSER_BODY_CLASS_NAME = "relative px-3 py-3 sm:px-4";
/** The + button, editor and send button, bottom-aligned as the editor grows. */
export const COMPOSER_INPUT_ROW_CLASS_NAME = "flex min-w-0 items-end gap-2";
/** The editor's height: one line, growing to six before it scrolls. */
export const COMPOSER_EDITOR_CLASS_NAME = "min-h-[1lh] max-h-[min(6lh,22dvh)] overscroll-contain";

/**
 * The rounded box every composer types into. `attachedMenu` is a panel that grows out of
 * its top edge (the + menu or the `@` menu); the box squares its top corners while one shows.
 */
export function ComposerSurface({
  attachedMenu,
  className,
  children,
  ...props
}: ComponentProps<"div"> & { readonly attachedMenu?: ReactNode }) {
  return (
    <div
      className={cn(
        "relative rounded-[28px] border border-border/60 shadow-sm transition-[background-color] duration-200",
        // An attached panel may also be portalled in, so the box reads its own children.
        "has-[>.chat-composer-attached-panel]:rounded-t-none",
        className,
      )}
      {...props}
    >
      {attachedMenu}
      {children}
    </div>
  );
}
