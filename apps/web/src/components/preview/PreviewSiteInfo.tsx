import { isLoopbackHost } from "@spiritdevs/shared/preview";
import {
  ArrowLeft,
  ChevronRight,
  Lock,
  LockOpen,
  Server,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Popover,
  PopoverClose,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";

interface SiteConnection {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly description: string;
}

/** How the page reached the browser. A loaded https page already passed certificate checks. */
export function siteConnection(url: URL): SiteConnection {
  if (url.protocol === "https:") {
    return {
      icon: Lock,
      title: "Connection is secure",
      description:
        "Your information (for example, passwords or credit card numbers) is private when it is sent to this site.",
    };
  }
  if (isLoopbackHost(url.hostname)) {
    return {
      icon: Server,
      title: "Local server",
      description: "This page is served from this computer, so it never crosses the network.",
    };
  }
  return {
    icon: LockOpen,
    title: "Connection is not secure",
    description:
      "Don't enter sensitive information on this site (for example, passwords or credit cards), because it could be stolen by attackers.",
  };
}

const ROW_CLASS_NAME =
  "flex h-10 w-full cursor-pointer items-center gap-3 rounded-md px-3.5 text-left text-sm font-medium hover:bg-accent";

/** The site button at the start of the address bar: who the page is from and its data. */
export function PreviewSiteInfo({
  url,
  onClearSiteData,
}: {
  url: string;
  onClearSiteData?: (() => void) | undefined;
}) {
  const [view, setView] = useState<"site" | "security">("site");
  if (!/^https?:\/\//i.test(url) || !URL.canParse(url)) return null;
  const parsed = new URL(url);
  const site = parsed.host.replace(/^www\./, "");
  const connection = siteConnection(parsed);
  const ConnectionIcon = connection.icon;
  const closeButton = (
    <PopoverClose
      render={<Button variant="ghost" size="icon-sm" aria-label="Close" type="button" />}
    >
      <X />
    </PopoverClose>
  );
  return (
    <Popover onOpenChange={(open) => !open && setView("site")}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className="rounded-full"
            aria-label="Site information"
            type="button"
          />
        }
      >
        <SlidersHorizontal />
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="w-80"
        viewportClassName="px-(--viewport-inline-padding) pt-3 pb-2 [--viewport-inline-padding:--spacing(2)]"
      >
        {view === "site" ? (
          <div className="flex flex-col">
            <div className="flex h-11 items-center justify-between pl-3 pr-1">
              <PopoverTitle className="truncate text-base">{site}</PopoverTitle>
              {closeButton}
            </div>
            <button type="button" className={ROW_CLASS_NAME} onClick={() => setView("security")}>
              <ConnectionIcon className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{connection.title}</span>
              <ChevronRight className="size-4 shrink-0" />
            </button>
            {onClearSiteData ? (
              <PopoverClose
                render={<button type="button" className={ROW_CLASS_NAME} />}
                onClick={onClearSiteData}
              >
                <Trash2 className="size-4 shrink-0" />
                <span className="min-w-0 flex-1 truncate">Clear site data</span>
              </PopoverClose>
            ) : null}
          </div>
        ) : (
          <div className="flex flex-col">
            <div className="-mx-(--viewport-inline-padding) flex items-start gap-3 border-b px-(--viewport-inline-padding) pb-3">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Back"
                type="button"
                className="ms-1.5"
                onClick={() => setView("site")}
              >
                <ArrowLeft />
              </Button>
              <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
                <PopoverTitle className="text-base">Security</PopoverTitle>
                <span className="truncate text-[13px] text-muted-foreground">{site}</span>
              </div>
              <div className="me-1">{closeButton}</div>
            </div>
            <div className="flex gap-3 px-3.5 pt-4 pb-3">
              <ConnectionIcon className="mt-0.5 size-4 shrink-0" />
              <div className="flex min-w-0 flex-col gap-1">
                <span className="text-sm font-medium leading-5">{connection.title}</span>
                <p className="text-[13px] leading-[1.45] text-muted-foreground">
                  {connection.description}
                </p>
              </div>
            </div>
          </div>
        )}
      </PopoverPopup>
    </Popover>
  );
}
