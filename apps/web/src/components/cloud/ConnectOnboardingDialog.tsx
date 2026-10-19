import { useAuth } from "@clerk/react";
import { useEffect, useRef, useState } from "react";

import {
  CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY,
  ConnectOnboardingOptOutSchema,
  EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE,
} from "~/cloud/connectOnboarding";
import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useEnvironments, usePrimaryEnvironment } from "~/state/environments";
import { CloudEnvironmentConnectRows } from "./CloudEnvironmentConnectList";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

/**
 * Post-sign-in onboarding wizard for Pathway Connect. Opens on every in-session
 * sign-in — sign-out removes the connected relay environments, so each new
 * session starts with no devices to reach. The current environment is published
 * automatically, so this dialog only lists the account's other environments.
 * A cold load with a restored session does not count as a sign-in.
 */
export function ConnectOnboardingDialog() {
  if (!hasCloudPublicConfig()) return null;

  return <ConfiguredConnectOnboardingDialog />;
}

function ConfiguredConnectOnboardingDialog() {
  // Mirrors ManagedRelayAuthProvider: a pending Clerk session must not read as
  // signed-out, or its later activation would look like a fresh sign-in.
  const { isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
  const [optOutState, setOptOutState] = useLocalStorage(
    CONNECT_ONBOARDING_OPT_OUT_STORAGE_KEY,
    EMPTY_CONNECT_ONBOARDING_OPT_OUT_STATE,
    ConnectOnboardingOptOutSchema,
  );

  const [requestedAccount, setRequestedAccount] = useState<string | null>(null);
  const [openForAccount, setOpenForAccount] = useState<string | null>(null);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const observedAccountRef = useRef<string | null | undefined>(undefined);

  const optOutAccounts = optOutState.optOutAccounts;

  // Every sign-in or account switch that completes during this session
  // requests the wizard — account transitions clear the connected relay
  // environments, so each new session starts with no devices to reach. A cold
  // load observes undefined → account and must not re-prompt.
  useEffect(() => {
    if (!isLoaded) return;
    // A loaded-but-incomplete snapshot (signed in, user id not yet populated)
    // must not be recorded as signed-out — the next render would then look
    // like a fresh sign-in on a cold load.
    if (isSignedIn && !userId) return;
    const previousAccount = observedAccountRef.current;
    const nextAccount = isSignedIn && userId ? userId : null;
    observedAccountRef.current = nextAccount;
    if (previousAccount !== undefined && previousAccount !== nextAccount && nextAccount !== null) {
      setRequestedAccount(nextAccount);
    }
  }, [isLoaded, isSignedIn, userId]);

  // Accounts that chose "Don't show this again" are skipped.
  useEffect(() => {
    if (requestedAccount === null || openForAccount !== null) return;
    if (optOutAccounts.includes(requestedAccount)) {
      setRequestedAccount(null);
      return;
    }
    setRequestedAccount(null);
    setDontShowAgain(false);
    setOpenForAccount(requestedAccount);
  }, [openForAccount, optOutAccounts, requestedAccount]);

  // Signing out (or switching accounts) mid-wizard invalidates everything the
  // wizard would do — close it and let the sign-in trigger re-evaluate.
  useEffect(() => {
    if (openForAccount !== null && (!isSignedIn || userId !== openForAccount)) {
      setOpenForAccount(null);
    }
    if (requestedAccount !== null && (!isSignedIn || userId !== requestedAccount)) {
      setRequestedAccount(null);
    }
  }, [isSignedIn, openForAccount, requestedAccount, userId]);

  const complete = () => {
    const account = openForAccount;
    setOpenForAccount(null);
    if (account !== null && dontShowAgain) {
      setOptOutState((state) =>
        state.optOutAccounts.includes(account)
          ? state
          : { optOutAccounts: [...state.optOutAccounts, account] },
      );
    }
  };

  return (
    <Dialog
      open={openForAccount !== null}
      onOpenChange={(open) => {
        if (!open) complete();
      }}
    >
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Set up Pathway Connect</DialogTitle>
          <DialogDescription>
            This environment is published automatically. Connect any other environments available to
            your account.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <DevicesStep />
        </DialogPanel>
        <DialogFooter variant="bare" className="sm:justify-between">
          <label className="flex cursor-pointer items-center gap-2 self-start text-xs text-muted-foreground sm:self-center">
            <Checkbox
              checked={dontShowAgain}
              onCheckedChange={(checked) => setDontShowAgain(checked === true)}
            />
            Don&apos;t show this again
          </label>
          <Button onClick={complete}>Done</Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function DevicesStep() {
  const { environments } = useEnvironments();
  const primaryEnvironment = usePrimaryEnvironment();
  const savedEnvironments = environments.filter(
    (environment) => environment.entry.target._tag !== "PrimaryConnectionTarget",
  );

  return (
    <div className="overflow-hidden rounded-lg border">
      <CloudEnvironmentConnectRows
        primaryEnvironmentId={primaryEnvironment?.environmentId ?? null}
        savedEnvironments={savedEnvironments}
        showSavedEnvironments
        empty={
          <p className="px-4 py-6 text-center text-sm text-muted-foreground">
            No other environments are published to your account yet. Publish one from another device
            and it will show up here.
          </p>
        }
      />
    </div>
  );
}
