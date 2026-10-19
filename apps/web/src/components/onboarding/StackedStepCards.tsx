import { useEffect, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * The onboarding deck: one active card with up to two "peek" layers behind it
 * hinting at the steps that remain. Every card is the same height so the deck
 * never jumps, and the active card owns a scrollable body with its controls
 * pinned to the bottom edge.
 *
 * Motion is CSS only — no animation library is installed, and a stepper is the
 * wrong place to add one. The active card is keyed by step id so React remounts
 * it, and the remount plays a single translate/fade transition.
 */

/**
 * Deepest layer last: each is inset further and lifted further above the active
 * card's top edge, so the deck reads as a stack seen slightly from below.
 */
const PEEK_LAYER_CLASSNAMES = [
  "inset-x-[11px] -translate-y-[9px] opacity-75",
  "inset-x-[22px] -translate-y-[18px] opacity-50",
];

const CARD_HEIGHT_CLASSNAME = "h-[560px]";

export function StackedStepCards({
  announcement,
  children,
  peekCount,
  stepId,
}: {
  /** "Step 2 of 3: …" — the only thing the live region announces. */
  readonly announcement: string;
  readonly children: ReactNode;
  readonly peekCount: number;
  readonly stepId: string;
}) {
  const peekLayers = PEEK_LAYER_CLASSNAMES.slice(0, peekCount).toReversed();

  return (
    <div aria-live="polite" className="relative">
      <p className="sr-only">{announcement}</p>

      {peekLayers.map((layerClassName) => (
        <div
          aria-hidden
          className={cn(
            "absolute top-0 rounded-2xl border border-border bg-card shadow-sm",
            CARD_HEIGHT_CLASSNAME,
            layerClassName,
          )}
          key={layerClassName}
        />
      ))}

      <ActiveStepCard key={stepId}>{children}</ActiveStepCard>
    </div>
  );
}

function ActiveStepCard({ children }: { readonly children: ReactNode }) {
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      setEntered(true);
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <article
      className={cn(
        "relative grid grid-rows-[minmax(0,1fr)_auto] overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xl shadow-black/8",
        "transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
        CARD_HEIGHT_CLASSNAME,
        entered ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0",
      )}
    >
      {children}
    </article>
  );
}

export function StepBody({ children }: { readonly children: ReactNode }) {
  return <div className="min-h-0 overflow-y-auto px-6 py-7 sm:px-8">{children}</div>;
}

export function StepHeader({
  description,
  title,
}: {
  readonly description: string;
  readonly title: string;
}) {
  return (
    <header className="mb-6">
      <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
      <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{description}</p>
    </header>
  );
}

export function StepControls({
  children,
  error,
}: {
  readonly children: ReactNode;
  readonly error: string | null;
}) {
  return (
    <div className="border-t border-border/70 px-6 py-4 sm:px-8">
      {error === null ? null : (
        <p className="mb-3 text-sm text-destructive-foreground" role="alert">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">{children}</div>
    </div>
  );
}
