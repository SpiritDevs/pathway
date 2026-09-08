import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@spiritdevs/client-runtime/state/runtime";
import { useRef, useState } from "react";

import { isElectron } from "../../env";
import { usePrimarySessionState } from "../../environments/primary";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentSessionState } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  resolvePrimaryOperateAccess,
  resolveRemoteOperateAccess,
  type ProviderOperateAccess,
} from "../settings/ProviderSettingsPanel.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ConnectedProviderUsageAccount } from "./providerUsageAccounts";

export interface ResetCreditSelection {
  readonly account: ConnectedProviderUsageAccount;
  readonly creditId: string;
}

interface ResetCreditDialogProps {
  readonly selection?: ResetCreditSelection;
  readonly onClose?: () => void;
  readonly onRequestRedeem?: ((selection: ResetCreditSelection) => void) | undefined;
}

export function ProviderResetCredits({
  accounts,
  onRequestRedeem,
}: {
  accounts: ReadonlyArray<ConnectedProviderUsageAccount>;
  onRequestRedeem?: ((selection: ResetCreditSelection) => void) | undefined;
}) {
  const supported = accounts.filter(
    (account) =>
      account.provider.driver === "codex" && account.snapshot?.resetCredits !== undefined,
  );
  if (supported.length === 0) return null;
  return (
    <section aria-label="Usage resets" className="space-y-3 border-t border-border/70 pt-3">
      <h3 className="text-xs font-medium text-foreground">Usage resets</h3>
      {supported.map((account) => (
        <AccountResetCredits
          key={account.key}
          account={account}
          onRequestRedeem={onRequestRedeem}
        />
      ))}
    </section>
  );
}

export function AccountResetCredits({
  account,
  ...dialogProps
}: { account: ConnectedProviderUsageAccount } & ResetCreditDialogProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  if (account.environmentId === primaryEnvironmentId) {
    return isElectron ? (
      <ProviderResetCreditList account={account} {...dialogProps} operateAccess="granted" />
    ) : (
      <PrimaryResetCredits account={account} {...dialogProps} />
    );
  }
  return <RemoteResetCredits account={account} {...dialogProps} />;
}

function PrimaryResetCredits({
  account,
  ...dialogProps
}: { account: ConnectedProviderUsageAccount } & ResetCreditDialogProps) {
  const session = usePrimarySessionState();
  return (
    <ProviderResetCreditList
      account={account}
      {...dialogProps}
      operateAccess={resolvePrimaryOperateAccess({
        isPrimary: true,
        hasDesktopBridge: false,
        session: session.data,
        isPending: session.isPending,
        hasError: session.error !== null,
      })}
    />
  );
}

function RemoteResetCredits({
  account,
  ...dialogProps
}: { account: ConnectedProviderUsageAccount } & ResetCreditDialogProps) {
  const session = useEnvironmentSessionState(account.environmentId);
  return (
    <ProviderResetCreditList
      account={account}
      {...dialogProps}
      operateAccess={resolveRemoteOperateAccess({
        session: session.data,
        isPending: session.isPending,
        hasError: session.hasError,
      })}
    />
  );
}

export function ProviderResetCreditList({
  account,
  operateAccess,
  selection,
  onClose,
  onRequestRedeem,
}: {
  account: ConnectedProviderUsageAccount;
  operateAccess: ProviderOperateAccess;
} & ResetCreditDialogProps) {
  const consumeResetCredit = useAtomCommand(serverEnvironment.consumeResetCredit, {
    reportFailure: false,
  });
  const [selectedCreditId, setSelectedCreditId] = useState<string | null>(
    selection?.creditId ?? null,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const snapshot = account.snapshot;
  const credits = snapshot?.resetCredits;
  const selectedCredit = credits?.credits.find((credit) => credit.id === selectedCreditId);
  const canRedeem =
    operateAccess === "granted" &&
    snapshot?.status === "ok" &&
    !snapshot.stale &&
    !credits?.stale &&
    !!snapshot.accountKey;
  const accountLabel = [account.displayName, account.provider.auth.email, account.environmentLabel]
    .filter(Boolean)
    .join(" · ");

  async function redeem() {
    if (inFlight.current || !canRedeem || !selectedCredit || !snapshot?.accountKey) return;
    if (Date.parse(selectedCredit.expiresAt) <= Date.now()) {
      setError("This reset has expired. Refresh usage to see available resets.");
      return;
    }
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      const result = await consumeResetCredit({
        environmentId: account.environmentId,
        input: {
          instanceId: account.provider.instanceId,
          accountKey: snapshot.accountKey,
          creditId: selectedCredit.id,
        },
      });
      if (result._tag !== "Success") {
        if (!isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(failure instanceof Error ? failure.message : "Could not redeem this reset.");
        }
        return;
      }
      const messages = {
        reset: "Usage reset redeemed",
        nothingToReset: "Your usage does not need a reset",
        noCredit: "This reset is no longer available",
        alreadyRedeemed: "This reset has already been redeemed",
      };
      toastManager.add(
        stackedThreadToast({
          type: result.value.outcome === "reset" ? "success" : "info",
          title: messages[result.value.outcome],
          description: result.value.warning ?? accountLabel,
        }),
      );
      setSelectedCreditId(null);
      onClose?.();
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  if (!credits) return null;
  const now = Date.now();
  const available = credits.credits
    .filter((credit) => Date.parse(credit.expiresAt) > now)
    .toSorted((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt));
  return (
    <div className="space-y-2 text-xs">
      {!selection ? (
        <>
          <div>
            <p className="break-words font-medium text-foreground">{accountLabel}</p>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {available.length} {available.length === 1 ? "reset available" : "resets available"}
            </p>
          </div>
          {available.map((credit) => (
            <div key={credit.id} className="flex items-center justify-between gap-3">
              <span className="text-[11px] text-muted-foreground">
                Expires{" "}
                <time dateTime={credit.expiresAt}>
                  {new Date(credit.expiresAt).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    year: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}
                </time>
              </span>
              <Button
                type="button"
                variant="outline"
                size="xs"
                disabled={!canRedeem || pending}
                aria-label={`Redeem reset for ${accountLabel}`}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  setError(null);
                  if (onRequestRedeem) onRequestRedeem({ account, creditId: credit.id });
                  else setSelectedCreditId(credit.id);
                }}
              >
                Redeem
              </Button>
            </div>
          ))}
          {available.length > 0 && !canRedeem ? (
            <p className="text-[11px] text-muted-foreground">
              {operateAccess === "pending"
                ? "Checking access…"
                : operateAccess === "denied"
                  ? "Operate access is required to redeem a reset."
                  : "Refresh usage before redeeming a reset."}
            </p>
          ) : null}
        </>
      ) : null}
      <AlertDialog
        open={selectedCreditId !== null}
        onOpenChange={(open) => {
          if (!open && !inFlight.current) {
            setSelectedCreditId(null);
            onClose?.();
          }
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Redeem a usage reset?</AlertDialogTitle>
            <AlertDialogDescription>
              Use one reset for {accountLabel} to reset its Codex usage limits. This consumes the
              reset immediately and cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p role="alert" className="px-6 pb-4 text-sm text-destructive">
              {error}
            </p>
          ) : null}
          {!selectedCredit ? (
            <p role="status" className="px-6 pb-4 text-sm text-muted-foreground">
              This reset is no longer available.
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={pending} />}>
              Cancel
            </AlertDialogClose>
            <Button
              type="button"
              disabled={pending || !canRedeem || !selectedCredit}
              aria-busy={pending}
              onClick={() => void redeem()}
            >
              {pending ? "Redeeming…" : "Redeem reset"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
