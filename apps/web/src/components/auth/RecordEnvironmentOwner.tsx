import { useAuth } from "@clerk/react";
import { useEffect } from "react";

import { recordPathwayCloudOwner } from "../../environments/primary";

/**
 * Tells the desktop app's environment which Pathway account is signed in, so a browser signed in
 * to the same account opens this environment without a pairing code.
 */
export function RecordEnvironmentOwner() {
  const { getToken, isSignedIn, userId } = useAuth();

  useEffect(() => {
    if (!isSignedIn) {
      return;
    }
    void getToken()
      .then((clerkToken) => (clerkToken ? recordPathwayCloudOwner(clerkToken) : undefined))
      .catch((error: unknown) => {
        console.warn("[pathway-auth] Could not record this environment's owner", error);
      });
  }, [getToken, isSignedIn, userId]);

  return null;
}
