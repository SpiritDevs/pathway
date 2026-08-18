import { XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { RightPanelSheet } from "../../RightPanelSheet";
import { Button } from "../../ui/button";
import { SheetDescription, SheetFooter, SheetHeader, SheetPanel, SheetTitle } from "../../ui/sheet";

export function CompanySettingsSheet({
  children,
  description,
  footer,
  onOpenChange,
  open,
  title,
}: {
  readonly children: ReactNode;
  readonly description: string;
  readonly footer: ReactNode;
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
      <SheetPanel className="space-y-5 p-5">{children}</SheetPanel>
      <SheetFooter className="px-5">{footer}</SheetFooter>
    </RightPanelSheet>
  );
}
