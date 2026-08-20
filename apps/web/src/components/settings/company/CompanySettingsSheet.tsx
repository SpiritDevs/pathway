import { XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { RightPanelSheet } from "../../RightPanelSheet";
import { Button } from "../../ui/button";
import { SheetDescription, SheetFooter, SheetHeader, SheetPanel, SheetTitle } from "../../ui/sheet";
import { SettingsSurfaceProvider } from "../settingsLayout";

export function CompanySettingsSheet({
  children,
  description,
  footer,
  leadingFooter,
  onOpenChange,
  open,
  title,
}: {
  readonly children: ReactNode;
  readonly description: string;
  readonly footer: ReactNode;
  readonly leadingFooter?: ReactNode;
  readonly onOpenChange: (open: boolean) => void;
  readonly open: boolean;
  readonly title: string;
}) {
  return (
    <RightPanelSheet
      open={open}
      onClose={() => onOpenChange(false)}
      widthStorageKey="pathway:company-settings-sheet-width"
      defaultWidth={520}
    >
      <SheetHeader className="relative border-b border-border/50 px-5 py-4 pe-12">
        <SheetTitle className="text-base">{title}</SheetTitle>
        <SheetDescription>{description}</SheetDescription>
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="absolute end-3 top-3"
          aria-label="Close"
          onClick={() => onOpenChange(false)}
        >
          <XIcon />
        </Button>
      </SheetHeader>
      {/*
        Settings rows size themselves against the named `settings` container, so
        the sheet body has to declare it — the rows are otherwise laid out for a
        full-width page inside a column less than half that wide.
      */}
      <SheetPanel className="@container/settings space-y-5 p-5">
        <SettingsSurfaceProvider surface="sheet">{children}</SettingsSurfaceProvider>
      </SheetPanel>
      <SheetFooter className="flex-col items-stretch gap-2 px-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-h-8 items-center">{leadingFooter}</div>
        <div className="flex items-center justify-end gap-2">{footer}</div>
      </SheetFooter>
    </RightPanelSheet>
  );
}
