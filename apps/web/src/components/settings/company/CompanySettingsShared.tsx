import { Building2Icon } from "lucide-react";
import type { ReactElement, ReactNode } from "react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

export function CompanySettingsEmptyState({
  title,
  description,
}: {
  readonly title: string;
  readonly description: string;
}) {
  return (
    <div className="flex min-h-72 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed px-6 text-center">
      <div className="flex size-10 items-center justify-center rounded-xl bg-muted text-muted-foreground">
        <Building2Icon className="size-5" />
      </div>
      <div className="space-y-1">
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

export function PermissionTooltip({
  tooltip,
  children,
}: {
  readonly tooltip: string | null;
  readonly children: ReactElement;
}) {
  if (tooltip === null) return children;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex">{children}</span>} />
      <TooltipPopup>{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

export function CompanySectionCard({ children }: { readonly children: ReactNode }) {
  return <div className="overflow-hidden rounded-xl border bg-card/30">{children}</div>;
}
