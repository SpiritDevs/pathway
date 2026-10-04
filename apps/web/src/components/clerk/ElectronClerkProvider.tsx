import { passkeys } from "@clerk/electron/passkeys";
import { ClerkProvider } from "@clerk/electron/react";
import type { ReactNode } from "react";

import { ClerkStartupBoundary } from "./ClerkStartupBoundary";

/** The desktop SDK bundles Clerk JS and must stay outside the ordinary web entry. */
export default function ElectronClerkProvider({
  publishableKey,
  children,
}: {
  readonly publishableKey: string;
  readonly children: ReactNode;
}) {
  return (
    <ClerkProvider publishableKey={publishableKey} passkeys={passkeys}>
      <ClerkStartupBoundary>{children}</ClerkStartupBoundary>
    </ClerkProvider>
  );
}
