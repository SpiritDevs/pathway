import { ClerkFailed, ClerkLoaded, ClerkLoading } from "@clerk/react";
import type { ReactNode } from "react";

import { SplashScreen } from "../SplashScreen";
import { Button } from "../ui/button";

/** Handles SDK startup failures before the router can resolve the account gate. */
export function ClerkStartupBoundary({ children }: { readonly children: ReactNode }) {
  return (
    <>
      <ClerkLoading>
        <SplashScreen reason="account" />
      </ClerkLoading>
      <ClerkFailed>
        <main className="surface-grain flex min-h-dvh items-center justify-center bg-background p-6 text-foreground">
          <div className="max-w-md space-y-4 text-center" role="alert">
            <h1 className="text-lg font-medium">Unable to check your account</h1>
            <p className="text-sm text-muted-foreground">
              Pathway could not start its sign-in service. Try again. If this continues, contact
              your workspace administrator to check the sign-in configuration for this website.
            </p>
            <Button onClick={() => window.location.reload()}>Try again</Button>
          </div>
        </main>
      </ClerkFailed>
      <ClerkLoaded>{children}</ClerkLoaded>
    </>
  );
}
