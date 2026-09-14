import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { conversationDetailsLayout } from "./conversationList";
import { cn } from "../../lib/utils";

export function FloatingDetailsPanel({
  anchor,
  open,
  onClose,
  children,
}: {
  anchor: RefObject<HTMLDivElement | null>;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const [layout, setLayout] = useState<ReturnType<typeof conversationDetailsLayout> | null>(null);
  useEffect(() => {
    const element = anchor.current;
    if (!element) return;
    const measure = () =>
      setLayout(conversationDetailsLayout(element.getBoundingClientRect(), window.innerWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [anchor]);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
      modal={false}
    >
      <Dialog.Portal>
        <Dialog.Viewport
          className={cn(
            "pointer-events-none fixed z-[130] overflow-hidden",
            !layout?.docked && "rounded-[26px]",
          )}
          style={
            layout
              ? {
                  left: layout.left,
                  top: layout.top,
                  width: layout.width,
                  height: layout.height,
                  right: "auto",
                  bottom: "auto",
                }
              : { visibility: "hidden" }
          }
        >
          {!layout?.docked && (
            <Dialog.Backdrop
              onClick={onClose}
              className="pointer-events-auto absolute inset-0 bg-black/40 transition-opacity duration-200 data-starting-style:opacity-0 data-ending-style:opacity-0 motion-reduce:transition-none"
            />
          )}
          <Dialog.Popup
            aria-label="Conversation details"
            style={{ width: layout?.panelWidth }}
            className={cn(
              "pointer-events-auto relative ml-auto flex h-full min-h-0 flex-col overflow-hidden border bg-popover text-popover-foreground shadow-xl outline-none transition-transform duration-250 ease-[cubic-bezier(0.25,1,0.5,1)] motion-reduce:transition-none",
              layout?.docked
                ? "rounded-r-2xl data-starting-style:-translate-x-full data-ending-style:-translate-x-full"
                : "rounded-r-[26px] data-starting-style:translate-x-full data-ending-style:translate-x-full",
            )}
          >
            {children}
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
