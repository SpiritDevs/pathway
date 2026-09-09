import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { XIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";

const DISMISS_TRANSITION_MS = 220;
const frontExitStyle = {
  opacity: 0,
  transform: "translate3d(0, 4rem, 0)",
} satisfies CSSProperties;
const stackedExitStyle = {
  opacity: 0,
  transform: "translate3d(0, 7rem, 0)",
} satisfies CSSProperties;
const restingStyle = {
  opacity: 1,
  transform: "none",
} satisfies CSSProperties;
const exitTransitionStyle = {
  transition: `transform ${DISMISS_TRANSITION_MS}ms ease-in, opacity ${DISMISS_TRANSITION_MS}ms ease-in`,
} satisfies CSSProperties;

// The collapsed cap peeking above the front banner is the only hint that more
// banners are stacked behind it, so its border must match the severity of the
// first hidden banner — a neutral banner must not masquerade as a warning.
const stackCapBorderClass: Record<ComposerBannerStackItem["variant"], string> = {
  default: "border-border",
  error: "border-destructive/24",
  info: "border-info/24",
  success: "border-success/24",
  warning: "border-warning/24",
};

export interface ComposerBannerStackItem {
  readonly id: string;
  readonly variant: "default" | "error" | "info" | "success" | "warning";
  readonly presentation?: "banner" | "lip";
  // Ordering hint for stack assemblers: front this banner even though its
  // variant is calm (e.g. live update progress). The stack itself ignores it.
  readonly urgent?: boolean;
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
  readonly actionClassName?: string;
  readonly dismissLabel?: string;
  readonly onDismiss?: () => void;
}

interface ComposerBannerStackProps {
  readonly className?: string;
  readonly items: ReadonlyArray<ComposerBannerStackItem>;
}

export function ComposerBannerStack({ className, items }: ComposerBannerStackProps) {
  const [requestedExitingItemId, setExitingItemId] = useState<string | null>(null);
  const dismissTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitingItemId =
    requestedExitingItemId !== null && items.some((item) => item.id === requestedExitingItemId)
      ? requestedExitingItemId
      : null;

  useEffect(() => {
    return () => {
      if (dismissTimeoutRef.current) {
        clearTimeout(dismissTimeoutRef.current);
      }
    };
  }, []);

  if (items.length === 0) {
    return null;
  }

  const frontItem = items[0];
  if (!frontItem) {
    return null;
  }
  const stackedItems = items.slice(1);
  const hasStack = stackedItems.length > 0;
  const frontItemIsLip = frontItem.presentation === "lip";
  const showCollapsedStackCap = hasStack && exitingItemId !== frontItem.id;
  const peekingItems = stackedItems.slice(0, 2);

  const requestDismiss = (item: ComposerBannerStackItem) => {
    if (!item.onDismiss || exitingItemId) {
      return;
    }
    setExitingItemId(item.id);
    if (dismissTimeoutRef.current) {
      clearTimeout(dismissTimeoutRef.current);
    }
    dismissTimeoutRef.current = setTimeout(() => {
      dismissTimeoutRef.current = null;
      item.onDismiss?.();
    }, DISMISS_TRANSITION_MS);
  };

  return (
    <div
      className={cn(
        "group/banner-stack mx-auto w-full min-w-0 max-w-3xl",
        "px-[1.375rem]",
        frontItemIsLip ? "-mb-2 pt-1" : "mb-2",
        hasStack ? "pt-5" : null,
        className,
      )}
    >
      <div
        className={cn(
          "relative flex flex-col-reverse transition-transform duration-150 ease-out group-hover/banner-stack:-translate-y-1 group-focus-within/banner-stack:-translate-y-1 motion-reduce:transition-none",
          hasStack ? "group-hover/banner-stack:z-50 group-focus-within/banner-stack:z-50" : null,
        )}
      >
        {showCollapsedStackCap
          ? peekingItems.map((item, index) => (
              <div
                key={item.id}
                data-composer-banner-stack-peek={index + 1}
                className={cn(
                  "pointer-events-none absolute inset-x-0 mx-auto h-8 rounded-t-[14px] border border-b-0 bg-background shadow-sm",
                  stackCapBorderClass[item.variant],
                  "transition-opacity duration-150 ease-out motion-reduce:transition-none",
                  "group-hover/banner-stack:opacity-0 group-focus-within/banner-stack:opacity-0",
                )}
                style={{
                  width: `${100 - (index + 1) * 4}%`,
                  top: -(index + 1) * 8,
                  zIndex: 2 - index,
                }}
                aria-hidden="true"
              />
            ))
          : null}
        <div
          className={cn(
            "relative z-10",
            exitingItemId === frontItem.id ? "pointer-events-none" : null,
          )}
          style={{
            ...exitTransitionStyle,
            ...(exitingItemId === frontItem.id ? frontExitStyle : restingStyle),
          }}
        >
          <ComposerBannerStackAlert
            item={frontItem}
            attachedToComposer={frontItemIsLip}
            presentation={frontItemIsLip ? "lip" : "banner"}
            exiting={exitingItemId === frontItem.id}
            onDismissRequest={() => requestDismiss(frontItem)}
          />
        </div>
        {hasStack ? (
          <div
            data-composer-banner-stack-expanded-items="true"
            className={cn(
              "relative z-20 grid grid-rows-[0fr] transition-[grid-template-rows] duration-150 ease-out motion-reduce:transition-none",
              "group-hover/banner-stack:grid-rows-[1fr] group-focus-within/banner-stack:grid-rows-[1fr]",
            )}
          >
            <div className="min-h-0 overflow-hidden">
              <div
                className={cn(
                  "invisible pointer-events-none opacity-0",
                  "translate-y-1 transform-gpu transition-[opacity,transform] duration-150 ease-out motion-reduce:transition-none",
                  "group-hover/banner-stack:visible group-hover/banner-stack:pointer-events-auto group-hover/banner-stack:translate-y-0 group-hover/banner-stack:opacity-100",
                  "group-focus-within/banner-stack:visible group-focus-within/banner-stack:pointer-events-auto group-focus-within/banner-stack:translate-y-0 group-focus-within/banner-stack:opacity-100",
                )}
              >
                {stackedItems
                  .map((item, index) => (
                    <div
                      key={item.id}
                      className={cn(
                        "mx-auto",
                        exitingItemId === item.id ? "pointer-events-none" : null,
                      )}
                      style={{
                        width: `${100 - Math.min(index + 1, 2) * 4}%`,
                        ...exitTransitionStyle,
                        ...(exitingItemId === item.id ? stackedExitStyle : restingStyle),
                      }}
                    >
                      <ComposerBannerStackAlert
                        item={item}
                        presentation="lip"
                        exiting={exitingItemId === item.id}
                        onDismissRequest={() => requestDismiss(item)}
                      />
                    </div>
                  ))
                  .toReversed()}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ComposerBannerStackAlert({
  attachedToComposer = false,
  item,
  presentation,
  exiting,
  onDismissRequest,
}: {
  readonly attachedToComposer?: boolean;
  readonly item: ComposerBannerStackItem;
  readonly presentation: "banner" | "lip";
  readonly exiting: boolean;
  readonly onDismissRequest: () => void;
}) {
  const dismissOnly = item.onDismiss && !item.actions;

  return (
    <Alert
      variant={item.variant}
      className={cn(
        "alert-glass",
        presentation === "lip"
          ? "min-h-8 rounded-b-none rounded-t-[14px] border-b-0 px-2.5 pt-1 text-[11px] shadow-none"
          : item.presentation === "lip"
            ? "min-h-8 rounded-[14px] px-2.5 py-1 text-[11px] shadow-none"
            : "rounded-[22px]",
        presentation === "lip" && (attachedToComposer ? "pb-3" : "pb-1"),
        item.className,
      )}
      data-presentation={presentation}
      data-variant={item.variant}
    >
      {item.icon}
      <AlertTitle>{item.title}</AlertTitle>
      {item.description ? <AlertDescription>{item.description}</AlertDescription> : null}
      {item.actions || item.onDismiss ? (
        <AlertAction
          className={cn(
            item.actionClassName,
            dismissOnly
              ? "max-sm:col-start-3 max-sm:row-start-1 max-sm:mt-0 max-sm:self-start"
              : undefined,
          )}
        >
          {item.actions}
          {item.onDismiss ? (
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={item.dismissLabel ?? "Dismiss warning"}
              disabled={exiting}
              onClick={onDismissRequest}
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : null}
        </AlertAction>
      ) : null}
    </Alert>
  );
}
