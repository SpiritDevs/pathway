import { type ReactNode } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import { StageBackdropArt } from "../SidebarStageBackdrop";
import { cn } from "~/lib/utils";

/**
 * Shared chrome for the unauthenticated and onboarding surfaces (/login,
 * /register, /onboarding): backdrop art, brand header, centered column.
 * `wide` fits the onboarding card stack; the default fits auth forms.
 */
export function AuthShell({
  children,
  width = "form",
}: {
  readonly children: ReactNode;
  readonly width?: "form" | "wide";
}) {
  return (
    <main className="surface-grain relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-4 py-16 text-foreground sm:px-6">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-64 overflow-hidden"
      >
        <StageBackdropArt variant="dev" />
        <div className="absolute inset-0 bg-linear-to-b from-transparent via-background/20 to-background" />
      </div>

      <section className={cn("relative z-10 w-full", width === "wide" ? "max-w-2xl" : "max-w-sm")}>
        <div className="mb-6 flex items-baseline justify-center gap-1.5 text-foreground">
          <span className="text-lg font-semibold tracking-tight">{APP_DISPLAY_NAME}</span>
          <span className="text-sm font-medium text-muted-foreground">Workspace</span>
        </div>
        {children}
      </section>
    </main>
  );
}
