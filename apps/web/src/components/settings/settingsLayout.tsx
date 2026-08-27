import { InfoIcon, Undo2Icon } from "lucide-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import {
  createContext,
  type ComponentPropsWithoutRef,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * Where settings content is being rendered. A page owns the scroll container,
 * the page gutters and the reading measure; a sheet already provides all three,
 * so the same panels must render flat inside one instead of nesting a second
 * scroller and a second set of gutters into a column half the width.
 */
export type SettingsSurface = "page" | "sheet";

const SettingsSurfaceContext = createContext<SettingsSurface>("page");

export function SettingsSurfaceProvider({
  children,
  surface,
}: {
  readonly children: ReactNode;
  readonly surface: SettingsSurface;
}) {
  return (
    <SettingsSurfaceContext.Provider value={surface}>{children}</SettingsSurfaceContext.Provider>
  );
}

export function useSettingsSurface(): SettingsSurface {
  return useContext(SettingsSurfaceContext);
}

interface SettingsSearchTargetContextValue {
  readonly targetId: string | null;
  readonly onTargetHandled: () => void;
}

const noop = () => undefined;
const SETTINGS_RETURN_SCROLL_PREFIX = "pathway:settings-return-scroll:";

export function rememberSettingsReturnScrollPosition(pathname: string): void {
  const container = document.querySelector<HTMLElement>(".settings-page-scroll-fade");
  if (!container) return;
  sessionStorage.setItem(
    `${SETTINGS_RETURN_SCROLL_PREFIX}${pathname}`,
    String(container.scrollTop),
  );
}

function readSettingsReturnScrollPosition(pathname: string): number | null {
  const key = `${SETTINGS_RETURN_SCROLL_PREFIX}${pathname}`;
  const raw = sessionStorage.getItem(key);
  if (raw === null) return null;
  const scrollTop = Number(raw);
  return Number.isFinite(scrollTop) && scrollTop >= 0 ? scrollTop : null;
}
const SettingsSearchTargetContext = createContext<SettingsSearchTargetContextValue>({
  targetId: null,
  onTargetHandled: noop,
});

export function SettingsSearchTargetProvider({
  targetId,
  onTargetHandled = noop,
  children,
}: {
  targetId: string | null;
  onTargetHandled?: () => void;
  children: ReactNode;
}) {
  const value = useMemo(() => ({ targetId, onTargetHandled }), [onTargetHandled, targetId]);
  return <SettingsSearchTargetContext value={value}>{children}</SettingsSearchTargetContext>;
}

function scrollAndFocusSettingsTarget(target: HTMLElement): void {
  const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const scrollTarget =
    target.tagName === "SECTION" && target.firstElementChild
      ? (target.firstElementChild as HTMLElement)
      : target;

  scrollTarget.scrollIntoView({
    behavior: prefersReducedMotion ? "auto" : "smooth",
    block: "center",
  });
  target.focus({ preventScroll: true });
  target.classList.remove("settings-search-target-pulse");
  if (prefersReducedMotion) return;
  void target.offsetWidth;
  target.classList.add("settings-search-target-pulse");
  // The class also suppresses the focus outline (the pulse is the destination
  // indicator), so drop it once the element is no longer the destination.
  target.addEventListener("blur", () => target.classList.remove("settings-search-target-pulse"), {
    once: true,
  });
}

/** The row id a settings-search jump is currently trying to reach, if any. */
export function useSettingsSearchTargetId(): string | null {
  return useContext(SettingsSearchTargetContext).targetId;
}

function useSettingsSearchTarget<T extends HTMLElement>(id: string | undefined) {
  const { targetId, onTargetHandled } = useContext(SettingsSearchTargetContext);
  const isSearchTarget = id !== undefined && id === targetId;
  const targetRef = useCallback(
    (target: T | null) => {
      if (target && isSearchTarget) {
        scrollAndFocusSettingsTarget(target);
        onTargetHandled();
      }
    },
    [isSearchTarget, onTargetHandled],
  );

  return targetRef;
}

/** Info affordance explaining how a setting interacts with the shared background policy. */
export function PolicyTooltip({ children }: { readonly children: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          <button
            type="button"
            className="inline-flex size-5 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground"
            aria-label="Background policy details"
          >
            <InfoIcon className="size-3.5" />
          </button>
        }
      />
      <TooltipPopup side="top" className="max-w-72">
        {children}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Re-render every `intervalMs`; return a stable timestamp snapshot for render-time relative labels. */
export function useRelativeTimeTick(intervalMs = 1_000) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return nowMs;
}

export function SettingsSection({
  title,
  icon,
  headerAction,
  children,
  className,
  ...sectionProps
}: ComponentPropsWithoutRef<"section"> & {
  title: string;
  icon?: ReactNode;
  headerAction?: ReactNode;
  children: ReactNode;
}) {
  const targetRef = useSettingsSearchTarget<HTMLElement>(sectionProps.id);

  return (
    <section
      {...sectionProps}
      ref={targetRef}
      tabIndex={sectionProps.id ? -1 : sectionProps.tabIndex}
      className={cn("space-y-3", className)}
    >
      <div className="@xl/settings:px-4 flex min-h-8 items-center justify-between gap-4 px-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold tracking-[-0.025em] text-foreground">
          {icon}
          {title}
        </h2>
        <div className="flex min-h-7 min-w-7 items-center justify-end">{headerAction}</div>
      </div>
      <div className="relative space-y-1 overflow-visible text-foreground">{children}</div>
    </section>
  );
}

export function SettingsRow({
  title,
  description,
  status,
  resetAction,
  control,
  children,
  className,
  ...rowProps
}: Omit<ComponentPropsWithoutRef<"div">, "title"> & {
  title: ReactNode;
  description?: ReactNode;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
}) {
  const targetRef = useSettingsSearchTarget<HTMLDivElement>(rowProps.id);

  return (
    <div
      {...rowProps}
      ref={targetRef}
      tabIndex={rowProps.id ? -1 : rowProps.tabIndex}
      className={cn(
        "@xl/settings:px-4 rounded-xl px-3",
        children ? "pt-3 pb-1" : "py-3",
        className,
      )}
    >
      {/*
        Two columns only once the *container* is wide enough for both. Keyed to
        the viewport this collapsed the label to a few characters per line
        whenever the same row was reused in a narrow surface such as a settings
        sheet, because the control column takes its intrinsic width and the
        label column is the one that gives.
      */}
      <div className="@xl/settings:grid @xl/settings:grid-cols-[minmax(0,1fr)_minmax(10rem,auto)] @xl/settings:items-center @xl/settings:gap-8 flex flex-col gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-h-5 items-center gap-1.5">
            <h3 className="text-sm font-medium tracking-[-0.005em] text-foreground">{title}</h3>
            <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center">
              {resetAction}
            </span>
          </div>
          {description ? (
            <p className="max-w-xl text-[13px] leading-[1.45] text-muted-foreground/80">
              {description}
            </p>
          ) : null}
          {status ? <div className="pt-0.5 text-xs text-muted-foreground">{status}</div> : null}
        </div>
        {control ? (
          <div className="@xl/settings:w-auto @xl/settings:justify-end flex w-full min-w-0 shrink-0 items-center gap-2">
            {control}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

export function SettingResetButton({
  label,
  disabled = false,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`Reset ${label} to default`}
            disabled={disabled}
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">Reset to default</TooltipPopup>
    </Tooltip>
  );
}

export function SettingsPageContainer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const navigate = useNavigate();
  const surface = useSettingsSurface();
  const { hash, pathname } = useLocation({
    select: (location) => ({ hash: location.hash, pathname: location.pathname }),
  });
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const targetId = hash.replace(/^#/, "") || null;
  const clearTargetHash = useCallback(() => {
    void navigate({ hash: "", replace: true, resetScroll: false, hashScrollIntoView: false });
  }, [navigate]);

  useLayoutEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if (targetId !== null) return;
    const scrollTop = readSettingsReturnScrollPosition(pathname);
    if (scrollTop === null) return;
    container.scrollTop = scrollTop;
    const restoreTimer = window.setTimeout(() => {
      container.scrollTop = scrollTop;
      sessionStorage.removeItem(`${SETTINGS_RETURN_SCROLL_PREFIX}${pathname}`);
    }, 0);
    return () => {
      window.clearTimeout(restoreTimer);
    };
  }, [pathname, targetId]);

  // A sheet already scrolls its own body and applies its own padding, so the
  // page chrome is dropped there: nesting a second scroller inside it strands
  // content behind the footer, and stacking both sets of gutters is what left
  // the column too narrow to lay out.
  if (surface === "sheet") {
    return (
      <SettingsSearchTargetProvider targetId={targetId} onTargetHandled={clearTargetHash}>
        <div className={cn("@container/settings flex w-full flex-col gap-10", className)}>
          {children}
        </div>
      </SettingsSearchTargetProvider>
    );
  }

  return (
    <SettingsSearchTargetProvider targetId={targetId} onTargetHandled={clearTargetHash}>
      <div
        ref={scrollContainerRef}
        className="settings-page-scroll-fade scrollbar-gutter-both flex-1 overflow-y-auto px-4 pt-10 pb-7 sm:px-8 sm:pt-12 sm:pb-10"
      >
        <div
          className={cn(
            "@container/settings mx-auto flex w-full max-w-4xl flex-col gap-12",
            className,
          )}
        >
          {children}
        </div>
      </div>
    </SettingsSearchTargetProvider>
  );
}

export function scrollToSettingsTarget(targetId: string): boolean {
  const target = document.getElementById(targetId);
  if (!target) return false;
  scrollAndFocusSettingsTarget(target);
  return true;
}
