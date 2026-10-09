"use client";

import type { DesktopPreviewColorScheme } from "@spiritdevs/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Minus, MoreHorizontal, Plus as PlusIcon, RotateCcw } from "lucide-react";

import { openBrowserDialog } from "~/browser/browserDialogs";
import { browserAddressSummary } from "~/components/settings/browser/BrowserContactInfoSettings";
import { useClientSettings } from "~/hooks/useSettings";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

import { previewBridge } from "./previewBridge";

const COLOR_SCHEME_OPTIONS: ReadonlyArray<{
  value: DesktopPreviewColorScheme;
  label: string;
}> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

interface Props {
  /** Active preview tab id. Tab-targeting actions are disabled without it. */
  tabId: string | null;
  /**
   * True only after the desktop bridge has registered a `webContentsId` for
   * the active tab. Tab-targeting actions throw on the desktop side until
   * then; we disable those items so the menu doesn't fire silent no-ops.
   */
  hasWebContents: boolean;
  /** Current zoom factor as a number (1.0 = 100%). */
  zoomFactor: number;
  /** Emulated `prefers-color-scheme` for the guest page. */
  colorScheme: DesktopPreviewColorScheme;
  /** Fixed viewport modes expose the device toolbar and resize rails. */
  deviceToolbarVisible: boolean;
  /** Switches between fill-panel mode and a fixed responsive viewport. */
  onToggleDeviceToolbar: () => void;
  /** Whether the preview floats over the chat; absent where floating isn't offered. */
  pictureInPicture: boolean;
  /** Floats the preview over the chat, or docks it back. */
  onPictureInPicture?: (() => void) | undefined;
  pictureInPictureDisabled: boolean;
  /** Whether the separate native always-on-top preview window is open. */
  nativePictureInPicture: boolean;
  /** Toggles the optional native always-on-top preview window. */
  onNativePictureInPicture: () => void;
  /** Opens the find bar for the active tab. */
  onFindInPage: () => void;
  /** Saves a screenshot of the active tab, like the chrome-row capture button. */
  onTakeScreenshot: () => void;
}

/**
 * Three-dot menu in the chrome row: page tools, zoom, view options, and the
 * way into browser data and settings. Without the desktop bridge the menu
 * still opens so the chrome reads the same, but bridge actions are disabled.
 */
export function PreviewMoreMenu({
  tabId,
  hasWebContents,
  zoomFactor,
  colorScheme,
  deviceToolbarVisible,
  onToggleDeviceToolbar,
  pictureInPicture,
  onPictureInPicture,
  pictureInPictureDisabled,
  nativePictureInPicture,
  onNativePictureInPicture,
  onFindInPage,
  onTakeScreenshot,
}: Props) {
  const navigate = useNavigate();
  const saveAddresses = useClientSettings((settings) => settings.browserSaveAddresses);
  const addresses = useClientSettings((settings) => settings.browserAddresses);
  const bridge = previewBridge;
  const tabDisabled = !bridge || !tabId || !hasWebContents;
  const callTab =
    (op: (bridge: NonNullable<typeof previewBridge>, tabId: string) => Promise<void>) => () => {
      if (!bridge || !tabId) return;
      void op(bridge, tabId).catch(() => undefined);
    };

  const zoomLabel = `${Math.round(zoomFactor * 100)}%`;
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-8 rounded-full border-border/70"
                  type="button"
                  aria-label="Preview menu"
                />
              }
            />
          }
        >
          <MoreHorizontal />
        </TooltipTrigger>
        <TooltipPopup>More</TooltipPopup>
      </Tooltip>
      {/* Opaque, not glass: these open over arbitrary page content, which would tint them. */}
      <MenuPopup align="end" sideOffset={6} className="min-w-64 bg-popover">
        <MenuItem onClick={callTab((b, id) => b.hardReload(id))} disabled={tabDisabled}>
          Hard reload
        </MenuItem>
        <MenuItem onClick={callTab((b, id) => b.openDevTools(id))} disabled={tabDisabled}>
          Open DevTools
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={onFindInPage} disabled={tabDisabled || !bridge?.findInPage}>
          Find in page
        </MenuItem>
        <MenuItem
          onClick={callTab((b, id) => b.print?.(id) ?? Promise.resolve())}
          disabled={tabDisabled || !bridge?.print}
        >
          Print…
        </MenuItem>
        <MenuItem onClick={onTakeScreenshot} disabled={tabDisabled}>
          Take a screenshot
        </MenuItem>
        <MenuSeparator />
        {/*
          Zoom row: label + inline control cluster. `closeOnClick=false`
          keeps the menu open while the user clicks the +/− buttons.
        */}
        <MenuItem
          closeOnClick={false}
          onClick={(event: React.MouseEvent) => event.preventDefault()}
          className="justify-between data-highlighted:bg-transparent"
          disabled={tabDisabled}
        >
          <span>Zoom</span>
          <span className="flex items-center gap-1.5">
            <span className="flex h-7 items-center rounded-md border border-border/70">
              <Button
                variant="ghost"
                size="icon-xs"
                type="button"
                className="h-full rounded-none rounded-s-md"
                onClick={callTab((b, id) => b.zoomOut(id))}
                aria-label="Zoom out"
                disabled={tabDisabled}
              >
                <Minus />
              </Button>
              <span className="flex h-full min-w-12 items-center justify-center border-x border-border/70 px-1 text-xs tabular-nums">
                {zoomLabel}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                type="button"
                className="h-full rounded-none rounded-e-md"
                onClick={callTab((b, id) => b.zoomIn(id))}
                aria-label="Zoom in"
                disabled={tabDisabled}
              >
                <PlusIcon />
              </Button>
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              type="button"
              onClick={callTab((b, id) => b.resetZoom(id))}
              aria-label="Reset zoom"
              disabled={tabDisabled}
            >
              <RotateCcw />
            </Button>
          </span>
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={onToggleDeviceToolbar} disabled={tabDisabled}>
          {deviceToolbarVisible ? "Hide device toolbar" : "Show device toolbar"}
        </MenuItem>
        {onPictureInPicture ? (
          <MenuItem onClick={onPictureInPicture} disabled={pictureInPictureDisabled}>
            {pictureInPicture ? "Close floating preview" : "Float preview over chat"}
          </MenuItem>
        ) : null}
        <MenuItem onClick={onNativePictureInPicture} disabled={tabDisabled}>
          {nativePictureInPicture
            ? "Close separate preview window"
            : "Open separate preview window"}
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger disabled={tabDisabled}>Appearance</MenuSubTrigger>
          <MenuSubPopup className="min-w-32 bg-popover">
            <MenuRadioGroup
              value={colorScheme}
              onValueChange={(value) => {
                if (!bridge || !tabId) return;
                void bridge
                  .setColorScheme(tabId, value as DesktopPreviewColorScheme)
                  .catch(() => undefined);
              }}
            >
              {COLOR_SCHEME_OPTIONS.map((option) => (
                <MenuRadioItem key={option.value} value={option.value}>
                  {option.label}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuSubPopup>
        </MenuSub>
        <MenuSeparator />
        <MenuItem onClick={() => openBrowserDialog("import")} disabled={!bridge?.browserImport}>
          Import cookies and passwords…
        </MenuItem>
        <MenuSub>
          <MenuSubTrigger>Passwords and autofill</MenuSubTrigger>
          <MenuSubPopup className="min-w-48 bg-popover">
            <MenuItem onClick={() => void navigate({ to: "/settings/browser/passwords" })}>
              Password manager
            </MenuItem>
            <MenuItem onClick={() => void navigate({ to: "/settings/browser/contact-info" })}>
              Contact info
            </MenuItem>
            {saveAddresses && addresses.length > 0 && bridge?.autofillAddress ? (
              <>
                <MenuSeparator />
                {addresses.map((address) => (
                  <MenuItem
                    key={address.id}
                    disabled={tabDisabled}
                    onClick={callTab(
                      (b, id) => b.autofillAddress?.(id, address) ?? Promise.resolve(),
                    )}
                  >
                    <span className="min-w-0 truncate">
                      Fill {address.fullName || browserAddressSummary(address)}
                    </span>
                  </MenuItem>
                ))}
              </>
            ) : null}
          </MenuSubPopup>
        </MenuSub>
        <MenuItem onClick={() => void navigate({ to: "/settings/browser/downloads" })}>
          Downloads
        </MenuItem>
        <MenuItem onClick={() => void navigate({ to: "/settings/browser/history" })}>
          History
        </MenuItem>
        <MenuItem onClick={() => openBrowserDialog("clear-data")} disabled={!bridge}>
          Clear browsing data…
        </MenuItem>
        <MenuSeparator />
        <MenuItem onClick={() => void navigate({ to: "/settings/browser" })}>
          Browser settings
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
}
