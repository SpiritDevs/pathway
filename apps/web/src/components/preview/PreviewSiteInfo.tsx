import type {
  DesktopPreviewBridge,
  DesktopPreviewCertificate,
  DesktopPreviewSiteInfo,
} from "@spiritdevs/contracts";
import { isLoopbackHost } from "@spiritdevs/shared/preview";
import {
  ArrowLeft,
  BadgeCheck,
  ChevronRight,
  ExternalLink,
  Info,
  Lock,
  LockOpen,
  Server,
  Settings,
  ShieldAlert,
  SlidersHorizontal,
  Trash2,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import {
  Popover,
  PopoverClose,
  PopoverPopup,
  PopoverTitle,
  PopoverTrigger,
} from "~/components/ui/popover";
import { Separator } from "~/components/ui/separator";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";

import { PreviewCertificateViewer, certificateName } from "./PreviewCertificateViewer";

type SecurityState = DesktopPreviewSiteInfo["securityState"];

interface SiteConnection {
  readonly icon: LucideIcon;
  readonly title: string;
  readonly description: string;
  readonly destructive?: boolean;
}

/** How the page reached the browser, from Chromium's security state for it. */
export function siteConnection(url: URL, securityState: SecurityState): SiteConnection {
  if (securityState === "secure") {
    return {
      icon: Lock,
      title: "Connection is secure",
      description:
        "Your information (for example, passwords or credit card numbers) is private when it is sent to this site.",
    };
  }
  if (securityState === "dangerous") {
    return {
      icon: ShieldAlert,
      title: "Dangerous site",
      description:
        "Attackers on this site might trick you into installing software or revealing information such as passwords or credit card numbers.",
      destructive: true,
    };
  }
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) {
    return {
      icon: Server,
      title: "Local server",
      description: "This page is served from this computer, so it never crosses the network.",
    };
  }
  if (securityState === "unknown") {
    return {
      icon: Info,
      title: "Connection not checked",
      description: "Pathway couldn't check this site's connection.",
    };
  }
  return {
    icon: LockOpen,
    title: "Connection is not secure",
    description:
      "Don't enter sensitive information on this site (for example, passwords or credit cards), because it could be stolen by attackers.",
  };
}

/** What the browser can do for the site in a tab. A missing action hides its row. */
export interface PreviewSiteActions {
  /** Loads the site's information when the dropdown opens. */
  readonly load?: (() => Promise<DesktopPreviewSiteInfo | null>) | undefined;
  readonly openSiteSettings?: (() => void) | undefined;
  readonly clearSiteData?: (() => void) | undefined;
}

/**
 * Site actions for a local browser tab, through the desktop bridge. `openTab`
 * opens a blank tab beside it and resolves to that tab's runtime id, or null.
 */
export function previewSiteActions(
  bridge: DesktopPreviewBridge,
  tabId: string,
  openTab: () => Promise<string | null>,
): PreviewSiteActions {
  const { siteInfo, openSiteSettings, clearSiteData } = bridge;
  return {
    load: siteInfo && (() => siteInfo(tabId)),
    // The main process loads Chrome's settings page into the new tab, so
    // neither the renderer nor the server ever supplies a browser page's address.
    openSiteSettings:
      openSiteSettings &&
      (() =>
        void (async () => {
          const targetTabId = await openTab();
          if (targetTabId !== null) await openSiteSettings(tabId, targetTabId);
        })().catch(() =>
          toastManager.add({ type: "error", title: "Site settings could not open" }),
        )),
    clearSiteData: clearSiteData && (() => void clearSiteData(tabId).catch(() => undefined)),
  };
}

const ROW_CLASS_NAME =
  "flex h-10 w-full cursor-pointer items-center gap-3 rounded-md px-3.5 text-left text-sm font-medium hover:bg-accent";

function CloseButton() {
  return (
    <PopoverClose
      render={<Button variant="ghost" size="icon-sm" aria-label="Close" type="button" />}
    >
      <X />
    </PopoverClose>
  );
}

/** The dropdown's first view: the site, its connection, and what you can do with it. */
export function SiteMainView({
  site,
  connection,
  pending,
  onShowSecurity,
  onOpenSiteSettings,
  onClearSiteData,
}: {
  site: string;
  connection: SiteConnection;
  /** The site's information is still loading; its rows wait rather than guess. */
  pending: boolean;
  onShowSecurity: () => void;
  onOpenSiteSettings?: (() => void) | undefined;
  onClearSiteData?: (() => void) | undefined;
}) {
  const ConnectionIcon = connection.icon;
  return (
    <div className="flex flex-col">
      <div className="flex h-11 items-center justify-between pl-3 pr-1">
        <PopoverTitle className="truncate text-base">{site}</PopoverTitle>
        <CloseButton />
      </div>
      {pending ? (
        <div aria-hidden className="h-10" />
      ) : (
        <button type="button" className={ROW_CLASS_NAME} onClick={onShowSecurity}>
          <ConnectionIcon
            className={cn("size-4 shrink-0", connection.destructive && "text-destructive")}
          />
          <span className="min-w-0 flex-1 truncate">{connection.title}</span>
          <ChevronRight className="size-4 shrink-0" />
        </button>
      )}
      {onClearSiteData ? (
        <button type="button" className={ROW_CLASS_NAME} onClick={onClearSiteData}>
          <Trash2 className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 truncate">Clear site data</span>
        </button>
      ) : null}
      {onOpenSiteSettings ? (
        <>
          <Separator className="my-1" />
          <button type="button" className={ROW_CLASS_NAME} onClick={onOpenSiteSettings}>
            <Settings className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">Site settings</span>
            <ExternalLink className="size-4 shrink-0 text-muted-foreground" />
          </button>
        </>
      ) : null}
    </div>
  );
}

/** The Security view: how the connection was made and the certificate behind it. */
export function SiteSecurityView({
  site,
  connection,
  details,
  certificate,
  onBack,
  onShowCertificate,
}: {
  site: string;
  connection: SiteConnection;
  details: DesktopPreviewSiteInfo["connection"];
  certificate: DesktopPreviewSiteInfo["certificate"];
  onBack: () => void;
  onShowCertificate: () => void;
}) {
  const ConnectionIcon = connection.icon;
  const leaf = certificate?.chain[0];
  const CertificateIcon = certificate?.isValid ? BadgeCheck : ShieldAlert;
  return (
    <div className="flex flex-col">
      <div className="-mx-(--viewport-inline-padding) flex items-start gap-3 border-b px-(--viewport-inline-padding) pb-3">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Back"
          type="button"
          className="ms-1.5"
          onClick={onBack}
        >
          <ArrowLeft />
        </Button>
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-0.5">
          <PopoverTitle className="text-base">Security</PopoverTitle>
          <span className="truncate text-[13px] text-muted-foreground">{site}</span>
        </div>
        <div className="me-1">
          <CloseButton />
        </div>
      </div>
      <div className="flex gap-3 px-3.5 pt-4 pb-3">
        <ConnectionIcon
          className={cn("mt-0.5 size-4 shrink-0", connection.destructive && "text-destructive")}
        />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-sm font-medium leading-5">{connection.title}</span>
          <p className="text-[13px] leading-[1.45] text-muted-foreground">
            {connection.description}
          </p>
          {details?.certificateError ? (
            <p className="text-[13px] leading-[1.45] text-destructive">
              {details.certificateError}
            </p>
          ) : null}
          {details?.summary ? (
            <p className="text-xs leading-[1.45] text-muted-foreground">{details.summary}</p>
          ) : null}
        </div>
      </div>
      {certificate && leaf ? (
        <button
          type="button"
          className="mx-1.5 mb-1.5 flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left hover:bg-accent"
          onClick={onShowCertificate}
        >
          <CertificateIcon
            className={cn("size-4 shrink-0", !certificate.isValid && "text-destructive")}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-sm font-medium">
              {certificate.isValid ? "Certificate is valid" : "Certificate is not valid"}
            </span>
            <span className="truncate text-[13px] text-muted-foreground">
              Issued to {certificateName(leaf)}
            </span>
          </span>
          <ChevronRight className="size-4 shrink-0" />
        </button>
      ) : null}
    </div>
  );
}

/** The site button at the start of the address bar: who the page is from and its data. */
export function PreviewSiteInfo({
  url,
  actions,
}: {
  url: string;
  actions?: PreviewSiteActions | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"site" | "security">("site");
  // The last answer, kept per origin so reopening shows it while it refreshes.
  // Null info means the desktop could not say.
  const [loaded, setLoaded] = useState<{
    readonly origin: string;
    readonly info: DesktopPreviewSiteInfo | null;
  } | null>(null);
  const [viewer, setViewer] = useState<{
    readonly chain: ReadonlyArray<DesktopPreviewCertificate>;
    readonly open: boolean;
  } | null>(null);
  const latestRequest = useRef(0);
  const parsed = /^https?:\/\//i.test(url) && URL.canParse(url) ? new URL(url) : null;
  const origin = parsed?.origin ?? null;
  const loadSiteInfo = useEffectEvent((requestedOrigin: string) => {
    const load = actions?.load;
    if (!load) return;
    // Only the latest request lands, so a slow answer for an earlier page cannot replace it.
    const request = ++latestRequest.current;
    const settle = (info: DesktopPreviewSiteInfo | null) => {
      if (request === latestRequest.current) setLoaded({ origin: requestedOrigin, info });
    };
    load().then(settle, () => settle(null));
  });
  // Loads when the dropdown opens, and again if the page moves to another site while it is open.
  useEffect(() => {
    if (open && origin !== null) loadSiteInfo(origin);
  }, [open, origin]);
  if (!parsed) return null;

  const site = parsed.host.replace(/^www\./, "");
  const current = loaded?.origin === origin ? loaded : null;
  const info = current?.info ?? null;
  // A desktop build without site information falls back to the scheme: a loaded
  // https page already passed Chromium's checks. Otherwise only its answer counts.
  const connection = siteConnection(
    parsed,
    !actions?.load
      ? parsed.protocol === "https:"
        ? "secure"
        : "insecure"
      : (info?.securityState ?? "unknown"),
  );
  const close = () => {
    setOpen(false);
    setView("site");
  };
  const runAndClose = (action: (() => void) | undefined) =>
    action &&
    (() => {
      action();
      close();
    });

  return (
    <>
      <Popover open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
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
            <SiteMainView
              site={site}
              connection={connection}
              pending={actions?.load !== undefined && current === null}
              onShowSecurity={() => setView("security")}
              onOpenSiteSettings={
                info?.runtime ? runAndClose(actions?.openSiteSettings) : undefined
              }
              onClearSiteData={runAndClose(actions?.clearSiteData)}
            />
          ) : (
            <SiteSecurityView
              site={site}
              connection={connection}
              details={info?.connection ?? null}
              certificate={info?.certificate ?? null}
              onBack={() => setView("site")}
              onShowCertificate={() => {
                if (!info?.certificate) return;
                setViewer({ chain: info.certificate.chain, open: true });
                close();
              }}
            />
          )}
        </PopoverPopup>
      </Popover>
      {viewer ? (
        <PreviewCertificateViewer
          chain={viewer.chain}
          open={viewer.open}
          onOpenChange={(next) => setViewer({ chain: viewer.chain, open: next })}
        />
      ) : null}
    </>
  );
}
