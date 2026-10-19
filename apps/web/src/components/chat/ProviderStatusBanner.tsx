import {
  type ServerProvider,
  type ServerProviderAuthenticationStartResult,
} from "@spiritdevs/contracts";
import { memo, type FormEvent, useState } from "react";
import { ExternalLinkIcon, InfoIcon, KeyRoundIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { cn } from "~/lib/utils";
import { formatProviderDriverKindLabel } from "../../providerModels";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

interface ProviderAuthenticationActions {
  readonly start: () => Promise<ServerProviderAuthenticationStartResult>;
  readonly complete: (flowId: string, authorizationCode?: string) => Promise<void>;
  readonly cancel: (flowId: string) => Promise<void>;
}

type AuthenticationState =
  | { readonly status: "idle" }
  | { readonly status: "starting" }
  | {
      readonly status: "awaiting-code" | "completing";
      readonly flowId: string;
      readonly authorizationUrl: string;
      readonly completion?: "browser";
      readonly userCode?: string;
    };

export function getProviderStatusBannerKey(status: ServerProvider | null): string | null {
  return !status || status.status === "ready" || status.status === "disabled"
    ? null
    : [status.instanceId, status.status, status.auth.status, status.message ?? ""].join("\u0000");
}

export function shouldShowProviderStatusBanner(
  status: ServerProvider | null,
  dismissedBannerKey: string | null,
): boolean {
  const bannerKey = getProviderStatusBannerKey(status);
  return bannerKey !== null && bannerKey !== dismissedBannerKey;
}

export const ProviderStatusBanner = memo(function ProviderStatusBanner({
  authentication,
  onDismiss,
  status,
}: {
  authentication?: ProviderAuthenticationActions | undefined;
  onDismiss: () => void;
  status: ServerProvider | null;
}) {
  const [authenticationState, setAuthenticationState] = useState<AuthenticationState>({
    status: "idle",
  });
  const [authorizationCode, setAuthorizationCode] = useState("");
  const [authenticationError, setAuthenticationError] = useState<string | null>(null);

  if (!status || status.status === "ready" || status.status === "disabled") {
    return null;
  }

  const providerName = status.displayName?.trim() || formatProviderDriverKindLabel(status.driver);
  const isUnauthenticated = status.status === "error" && status.auth.status === "unauthenticated";
  const supportsLogin = isUnauthenticated && status.auth.supportsLogin === true && authentication;
  const title = isUnauthenticated
    ? `Sign in to ${providerName}`
    : `${providerName} provider status`;
  const message = isUnauthenticated
    ? supportsLogin
      ? "Reconnect your account here to keep working."
      : "Reconnect this provider to keep working."
    : (status.message ??
      (status.status === "error"
        ? `${providerName} provider is unavailable.`
        : `${providerName} provider has limited availability.`));
  const isStarting = authenticationState.status === "starting";
  const isCompleting = authenticationState.status === "completing";
  const activeFlow =
    authenticationState.status === "awaiting-code" || authenticationState.status === "completing"
      ? authenticationState
      : null;

  const startAuthentication = async () => {
    if (!supportsLogin || isStarting) return;
    setAuthenticationError(null);
    setAuthenticationState({ status: "starting" });
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    try {
      const result = await authentication.start();
      setAuthenticationState({
        status: "awaiting-code",
        flowId: result.flowId,
        authorizationUrl: result.authorizationUrl,
        ...(result.completion ? { completion: result.completion } : {}),
        ...(result.userCode ? { userCode: result.userCode } : {}),
      });
      if (popup) {
        try {
          popup.location.href = result.authorizationUrl;
        } catch {
          popup.close();
        }
      }
    } catch (error) {
      popup?.close();
      setAuthenticationState({ status: "idle" });
      setAuthenticationError(
        error instanceof Error ? error.message : `${providerName} sign-in could not be started.`,
      );
    }
  };

  const completeAuthentication = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      !authentication ||
      !activeFlow ||
      (activeFlow.completion !== "browser" && !authorizationCode.trim()) ||
      isCompleting
    ) {
      return;
    }
    setAuthenticationError(null);
    setAuthenticationState({ ...activeFlow, status: "completing" });
    try {
      await authentication.complete(
        activeFlow.flowId,
        activeFlow.completion === "browser" ? undefined : authorizationCode.trim(),
      );
    } catch (error) {
      setAuthenticationState({ ...activeFlow, status: "awaiting-code" });
      setAuthenticationError(
        error instanceof Error ? error.message : `${providerName} sign-in could not be completed.`,
      );
    }
  };

  const cancelAuthentication = async () => {
    if (!authentication || !activeFlow) return;
    await authentication.cancel(activeFlow.flowId).catch(() => undefined);
    setAuthenticationState({ status: "idle" });
    setAuthorizationCode("");
    setAuthenticationError(null);
  };

  return (
    <div className="pointer-events-auto mx-auto w-fit max-w-[calc(100%-2rem)] pt-3">
      <div
        className={cn(
          "alert-glass relative inline-flex max-w-xl items-start gap-3 rounded-xl border py-3 ps-3.5 pe-10 text-card-foreground text-sm",
          isUnauthenticated || status.status === "warning"
            ? "border-warning/32 [&_svg]:text-warning"
            : "border-destructive/32 text-destructive-foreground [&_svg]:text-destructive",
        )}
        data-variant={isUnauthenticated ? "authentication" : status.status}
        role="alert"
      >
        {isUnauthenticated ? (
          <KeyRoundIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        ) : (
          <InfoIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
        )}
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="font-medium">{title}</div>
          {isUnauthenticated ? (
            <div className="text-muted-foreground">{message}</div>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={<div className="line-clamp-3 text-muted-foreground">{message}</div>}
              />
              <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
                {message}
              </TooltipPopup>
            </Tooltip>
          )}
          {supportsLogin && activeFlow ? (
            <form className="mt-1 flex flex-col gap-2" onSubmit={completeAuthentication}>
              {activeFlow.completion === "browser" ? (
                <div className="flex flex-col gap-2">
                  <div className="text-muted-foreground text-xs">
                    Enter this one-time code on the OpenAI sign-in page, then return here.
                  </div>
                  <code className="w-fit select-all rounded-md bg-foreground/8 px-2.5 py-1.5 font-semibold tracking-widest text-foreground">
                    {activeFlow.userCode}
                  </code>
                </div>
              ) : (
                <div className="text-muted-foreground text-xs">
                  Finish signing in with {providerName}, then paste the authorization code here.
                </div>
              )}
              <div className="flex flex-col gap-2 sm:flex-row">
                {activeFlow.completion !== "browser" ? (
                  <Input
                    aria-label={`${providerName} authorization code`}
                    autoComplete="off"
                    className="min-w-56 flex-1"
                    disabled={isCompleting}
                    nativeInput
                    onChange={(event) => setAuthorizationCode(event.currentTarget.value)}
                    placeholder="Authorization code"
                    size="sm"
                    value={authorizationCode}
                  />
                ) : null}
                <Button
                  disabled={
                    (activeFlow.completion !== "browser" && !authorizationCode.trim()) ||
                    isCompleting
                  }
                  size="sm"
                  type="submit"
                >
                  {isCompleting ? <LoaderCircleIcon className="animate-spin" /> : null}
                  {isCompleting
                    ? "Connecting"
                    : activeFlow.completion === "browser"
                      ? "I've signed in"
                      : "Connect"}
                </Button>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <a
                  className="inline-flex items-center gap-1 text-foreground underline-offset-4 hover:underline"
                  href={activeFlow.authorizationUrl}
                  rel="noreferrer"
                  target="_blank"
                >
                  Open {providerName} sign-in
                  <ExternalLinkIcon className="size-3" />
                </a>
                <button
                  className="text-muted-foreground hover:text-foreground"
                  onClick={() => void cancelAuthentication()}
                  type="button"
                >
                  Cancel
                </button>
              </div>
            </form>
          ) : supportsLogin ? (
            <div className="mt-1">
              <Button disabled={isStarting} onClick={() => void startAuthentication()} size="sm">
                {isStarting ? <LoaderCircleIcon className="animate-spin" /> : <KeyRoundIcon />}
                {isStarting ? "Starting sign-in" : "Sign in"}
              </Button>
            </div>
          ) : null}
          {authenticationError ? (
            <div className="text-destructive-foreground text-xs" role="status">
              {authenticationError}
            </div>
          ) : null}
        </div>
        <button
          type="button"
          aria-label={`Dismiss ${providerName} provider ${status.status}`}
          className="absolute top-2 right-2 inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => {
            if (activeFlow) void cancelAuthentication();
            onDismiss();
          }}
        >
          <XIcon aria-hidden className="size-3.5" />
        </button>
      </div>
    </div>
  );
});
