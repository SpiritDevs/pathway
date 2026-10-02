import { useAuth } from "@clerk/react";
import { squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { startTransition, useCallback, useEffect, useRef, useState } from "react";

import { APP_DISPLAY_NAME } from "../../branding";
import { connectPairing } from "../../connection/onboarding";
import {
  peekPairingTokenFromUrl,
  signInWithPathwayCloud,
  stripPairingTokenFromUrl,
  submitServerAuthCredential,
} from "../../environments/primary";
import { continueWithoutServingEnvironment, readHostedPairingRequest } from "../../hostedPairing";
import { Button } from "../ui/button";
import { useAtomCommand } from "../../state/use-atom-command";

export function PairingPendingSurface({
  title = "Signing in",
  description = "Preparing your session with this environment.",
}: {
  readonly title?: string;
  readonly description?: string;
}) {
  return (
    <div className="pairing-surface relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pairing-surface-glow pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-emerald-500)_14%,transparent),transparent)]" />
        <div className="absolute inset-y-0 left-0 w-72 bg-[radial-gradient(28rem_18rem_at_left,color-mix(in_srgb,var(--color-sky-500)_10%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{description}</p>
      </section>
    </div>
  );
}

/**
 * Starts a session with the environment serving this page, without asking for anything. A pairing
 * link's token is redeemed; otherwise the signed-in Pathway account signs in as the environment's
 * owner. When neither works, the app reloads as a client of the account's other environments.
 */
export function PairingRouteSurface({ onAuthenticated }: { readonly onAuthenticated: () => void }) {
  const { getToken, isLoaded, isSignedIn } = useAuth();
  const navigate = useNavigate();
  const attemptedRef = useRef(false);

  useEffect(() => {
    if (!isLoaded || attemptedRef.current) {
      return;
    }
    attemptedRef.current = true;
    const pairingToken = peekPairingTokenFromUrl();
    if (pairingToken === null && !isSignedIn) {
      void navigate({ to: "/login", replace: true });
      return;
    }
    const signIn =
      pairingToken !== null
        ? submitServerAuthCredential(pairingToken)
        : getToken().then((clerkToken) => {
            if (!clerkToken) {
              throw new Error("No Pathway Cloud session.");
            }
            return signInWithPathwayCloud(clerkToken);
          });
    stripPairingTokenFromUrl();
    void signIn.then(() => startTransition(onAuthenticated), continueWithoutServingEnvironment);
  }, [getToken, isLoaded, isSignedIn, navigate, onAuthenticated]);

  return <PairingPendingSurface />;
}

export function HostedPairingRouteSurface() {
  const connectPairingEnvironment = useAtomCommand(connectPairing, {
    reportFailure: false,
  });
  const hostedPairingRequestRef = useRef(readHostedPairingRequest());
  const [status, setStatus] = useState<"pairing" | "paired" | "error">(() =>
    hostedPairingRequestRef.current ? "pairing" : "error",
  );
  const [message, setMessage] = useState(() =>
    hostedPairingRequestRef.current
      ? "Connecting to this backend."
      : "This pairing link is missing its backend host or token.",
  );
  const [canRetry, setCanRetry] = useState(false);
  const submitAttemptedRef = useRef(false);
  const tokenSubmittedRef = useRef(false);

  const submitHostedPairingRequest = useCallback(async () => {
    const request = hostedPairingRequestRef.current;

    if (!request) {
      setStatus("error");
      setMessage("This pairing link is missing its backend host or token.");
      setCanRetry(false);
      return;
    }

    if (tokenSubmittedRef.current) {
      setStatus("error");
      setMessage("This one-time pairing token was already submitted. Request a new pairing link.");
      setCanRetry(false);
      return;
    }

    setStatus("pairing");
    setMessage("Connecting to this backend.");
    setCanRetry(false);
    tokenSubmittedRef.current = true;

    const result = await connectPairingEnvironment({
      host: request.host,
      pairingCode: request.token,
    });
    if (result._tag === "Success") {
      setStatus("paired");
      setMessage(`${request.label || "The environment"} is saved in this browser.`);
      return;
    }

    tokenSubmittedRef.current = false;
    setStatus("error");
    setCanRetry(true);
    setMessage(
      `${errorMessageFromUnknown(squashAtomCommandFailure(result))} If the backend accepted this one-time token, request a new pairing link before retrying.`,
    );
  }, [connectPairingEnvironment]);

  useEffect(() => {
    if (submitAttemptedRef.current) {
      return;
    }
    submitAttemptedRef.current = true;

    stripPairingTokenFromUrl();
    void submitHostedPairingRequest();
  }, [submitHostedPairingRequest]);

  const request = hostedPairingRequestRef.current;

  return (
    <div className="pairing-surface relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pairing-surface-glow pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-emerald-500)_14%,transparent),transparent)]" />
        <div className="absolute inset-y-0 left-0 w-72 bg-[radial-gradient(28rem_18rem_at_left,color-mix(in_srgb,var(--color-sky-500)_10%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          {status === "paired"
            ? "Backend paired"
            : status === "error"
              ? "Pairing failed"
              : "Pairing backend"}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>

        {request ? (
          <div className="mt-5 rounded-lg border border-border/70 bg-background/55 px-3 py-3 text-xs leading-relaxed text-muted-foreground">
            Host: <span className="font-mono text-foreground/80">{request.host}</span>
          </div>
        ) : null}

        {status === "error" ? (
          <div className="mt-5 rounded-lg border border-destructive/30 bg-destructive/6 px-3 py-2 text-sm text-destructive">
            Verify the backend is reachable from this browser, supports CORS for hosted clients, and
            is served over HTTPS when opening this page from HTTPS.
          </div>
        ) : null}

        <div className="mt-6 flex flex-wrap gap-2">
          {status === "pairing" ? (
            <Button disabled size="sm">
              Pairing...
            </Button>
          ) : canRetry ? (
            <Button size="sm" onClick={() => void submitHostedPairingRequest()}>
              Try again
            </Button>
          ) : null}
          {status === "paired" ? (
            <Button size="sm" variant="outline" onClick={() => (window.location.href = "/")}>
              Open app
            </Button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

function errorMessageFromUnknown(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Authentication failed.";
}
