import { type AuthSessionState, type ServerLifecycleWelcomePayload } from "@spiritdevs/contracts";
import { scopedProjectKey, scopeProjectRef } from "@spiritdevs/client-runtime/environment";
import {
  isOnboardingComplete,
  parseProfileMetadata,
  recoverMissingOnboardingWorkspace,
  restartOnboardingForWorkspaceRecovery,
} from "@spiritdevs/client-runtime/profile";
import { squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";
import { useAuth, useUser } from "@clerk/react";
import {
  Outlet,
  createRootRoute,
  type ErrorComponentProps,
  useLocation,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";

import { APP_BASE_NAME, APP_DISPLAY_NAME, APP_STAGE_LABEL } from "../branding";
import { resolveServerBackedAppDisplayName } from "../branding.logic";
import {
  hasClerkPublicConfig,
  resolveCloudSyncConvexUrl,
  resolveConvexClerkTokenOptions,
} from "../cloud/publicConfig";
import { AppSidebarLayout } from "../components/AppSidebarLayout";
import { PairingRouteSurface } from "../components/auth/PairingRouteSurface";
import { CommandPalette } from "../components/CommandPalette";
import { ConfirmDialogHost } from "../components/ConfirmDialogHost";
import { PullRequestAgentReviewHost } from "../components/pullRequest/PullRequestAgentReviewHost";
import { AssignProjectCompanyDialog } from "../components/projects/AssignProjectCompanyDialog";
import { AttachProjectDirectoryHost } from "../components/projects/AttachProjectDirectoryDialog";
import { ConnectOnboardingDialog } from "../components/cloud/ConnectOnboardingDialog";
import { SshPasswordPromptDialog } from "../components/desktop/SshPasswordPromptDialog";
import { SplashScreen } from "../components/SplashScreen";
import { resolveAuthGateLoadingReason } from "../components/splashScreen.logic";
import { SlowRpcRequestToastCoordinator } from "../components/SlowRpcRequestToastCoordinator";
import { EmailCaptureToastHost } from "../components/email/EmailCaptureToastHost";
import { ThemeEditorHost } from "../components/settings/ThemeEditorHost";
import { Button } from "../components/ui/button";
import {
  AnchoredToastProvider,
  stackedThreadToast,
  ToastProvider,
  toastManager,
} from "../components/ui/toast";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { applyAppearanceFontVariables } from "~/appearanceFonts";
import { useClientSettings } from "../hooks/useSettings";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKeyFromPath,
  selectProjectGroupingSettings,
} from "../logicalProject";
import { useUiStateStore } from "../uiStateStore";
import { syncBrowserChromeTheme } from "../hooks/useTheme";
import { configureClientTracing } from "../observability/clientTracing";
import { resolveInitialServerAuthGateState } from "../environments/primary";
import { hasHostedPairingRequest, isHostedStaticApp } from "../hostedPairing";
import { shellEnvironment } from "../state/shell";
import { useAtomValue } from "@effect/atom-react";
import { useAtomCommand } from "../state/use-atom-command";
import { useEnvironments, usePrimaryEnvironment } from "../state/environments";
import {
  primaryServerConfigAtom,
  primaryServerConfigEventAtom,
  primaryServerWelcomeAtom,
} from "../state/server";
import { readProject, setActiveEnvironmentId, useActiveEnvironmentId } from "../state/entities";
import {
  createKeybindingsUpdateToastController,
  type KeybindingsUpdateToastController,
} from "../components/KeybindingsUpdateToast.logic";
import { resolveClerkAuthGateState } from "../components/clerk/authGate.logic";

// #region DEBUG
function debugAuthGate(
  hypothesis: "H1" | "H2",
  event: string,
  fields: Readonly<Record<string, string | number | boolean | null>>,
): void {
  void fetch("/api/__debug/cloud-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ hypothesis, event, fields }),
  }).catch(() => undefined);
}
// #endregion DEBUG

export const Route = createRootRoute({
  beforeLoad: async ({ location }) => {
    if (
      location.pathname === "/login" ||
      location.pathname === "/register" ||
      location.pathname === "/onboarding"
    ) {
      return {
        authGateState: {
          status: "hosted-static",
        } as const,
      };
    }

    if (location.pathname === "/pair" && hasHostedPairingRequest(new URL(window.location.href))) {
      return {
        authGateState: {
          status: "hosted-pairing",
        } as const,
      };
    }

    if (isHostedStaticApp(new URL(window.location.href))) {
      return {
        authGateState: {
          status: "hosted-static",
        } as const,
      };
    }

    const authGateState = await resolveInitialServerAuthGateState();
    return {
      authGateState,
    };
  },
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  // Nothing below can render until `beforeLoad` has resolved the primary
  // environment, so without a pending component the boot shell blinks out to an
  // empty background while that bootstrap runs. `pendingMs: 0` hands the splash
  // straight over; an already-bootstrapped gate state resolves in a microtask,
  // ahead of that timer, so navigations never flash it. `pendingMinMs: 0` keeps
  // the default 500ms floor from padding a boot that was quicker than that.
  pendingComponent: EnvironmentPendingView,
  pendingMs: 0,
  pendingMinMs: 0,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function EnvironmentPendingView() {
  return <SplashScreen reason="environment" />;
}

function RootRouteView() {
  const pathname = useLocation({ select: (location) => location.pathname });

  // Fail closed: accounts are mandatory (docs/internals/decisions/0001). A
  // build without a Clerk publishable key is a misconfiguration, not an open
  // app.
  return hasClerkPublicConfig() ? (
    <ConfiguredClerkAuthGate pathname={pathname} />
  ) : (
    <MissingAuthConfigScreen />
  );
}

function MissingAuthConfigScreen() {
  return (
    <main className="surface-grain flex min-h-dvh items-center justify-center bg-background px-4 text-foreground">
      <section className="w-full max-w-md rounded-2xl border border-border/70 bg-card p-6 shadow-xl shadow-black/8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-xl font-semibold tracking-tight">
          Authentication is not configured.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          This build has no Clerk publishable key, and {APP_DISPLAY_NAME} requires an account to
          run. Set <code className="text-foreground/90">PATHWAY_CLERK_PUBLISHABLE_KEY</code> in the
          repository-root <code className="text-foreground/90">.env</code> and rebuild.
        </p>
      </section>
    </main>
  );
}

function ConfiguredClerkAuthGate({ pathname }: { readonly pathname: string }) {
  const { getToken, isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const navigate = useNavigate();
  const metadata = user ? parseProfileMetadata(user.unsafeMetadata) : null;
  const onboardingComplete = isSignedIn
    ? user
      ? isOnboardingComplete(metadata)
      : undefined
    : undefined;
  const fetchConvexToken = useCallback(
    () => getToken(resolveConvexClerkTokenOptions()),
    [getToken],
  );
  useWorkspaceRecoveryValidation({
    enabled: onboardingComplete === true,
    fetchToken: fetchConvexToken,
    user,
  });
  const gateState = resolveClerkAuthGateState({
    isLoaded,
    isSignedIn,
    onboardingComplete,
    pathname,
  });

  // #region DEBUG
  const gateEffectCount = useRef(0);

  useEffect(() => {
    debugAuthGate("H2", "auth-state-committed", {
      gateState,
      isLoaded,
      isSignedIn: isSignedIn ?? null,
      onboardingComplete: onboardingComplete ?? null,
      pathname,
    });
  }, [gateState, isLoaded, isSignedIn, onboardingComplete, pathname]);
  // #endregion DEBUG

  useEffect(() => {
    // #region DEBUG
    gateEffectCount.current += 1;
    const effectCount = gateEffectCount.current;
    const destination =
      gateState === "redirect" ? "/login" : gateState === "onboarding" ? "/onboarding" : null;
    debugAuthGate("H1", "redirect-effect-entered", {
      destination,
      effectCount,
      gateState,
      pathname,
    });
    // #endregion DEBUG
    if (gateState === "redirect") {
      // #region DEBUG
      void navigate({ replace: true, to: "/login" }).then(
        () =>
          debugAuthGate("H1", "navigation-settled", {
            destination: "/login",
            effectCount,
            pathname,
          }),
        () =>
          debugAuthGate("H1", "navigation-rejected", {
            destination: "/login",
            effectCount,
            pathname,
          }),
      );
      // #endregion DEBUG
    }
    if (gateState === "onboarding") {
      // #region DEBUG
      void navigate({ replace: true, to: "/onboarding" }).then(
        () =>
          debugAuthGate("H1", "navigation-settled", {
            destination: "/onboarding",
            effectCount,
            pathname,
          }),
        () =>
          debugAuthGate("H1", "navigation-rejected", {
            destination: "/onboarding",
            effectCount,
            pathname,
          }),
      );
      // #endregion DEBUG
    }
  }, [gateState, navigate]);

  const loadingReason = resolveAuthGateLoadingReason({ gateState, isLoaded });
  if (loadingReason) {
    return <SplashScreen reason={loadingReason} />;
  }

  return <RootRouteContent pathname={pathname} />;
}

/**
 * Confirms in the background that a completed Clerk profile still has a matching
 * Convex workspace. Never holds the app: only an authoritative empty catalog
 * restarts onboarding — by clearing the completion marker, which flips the auth
 * gate on a later render. A network, token, or configuration failure leaves
 * existing profile state untouched so a transient outage cannot lock the user
 * out.
 */
function useWorkspaceRecoveryValidation(options: {
  readonly enabled: boolean;
  readonly fetchToken: () => Promise<string | null>;
  readonly user: ReturnType<typeof useUser>["user"];
}): void {
  const convexUrl = resolveCloudSyncConvexUrl();
  const completionMarker = options.user
    ? parseProfileMetadata(options.user.unsafeMetadata)?.onboardingCompletedAt
    : undefined;
  const validationKey =
    options.enabled && options.user && completionMarker && convexUrl
      ? `${options.user.id}:${completionMarker}`
      : null;

  useEffect(() => {
    const user = options.user;
    if (validationKey === null || convexUrl === null || !user) return;
    let cancelled = false;

    void (async () => {
      try {
        const { hasUsableOnboardingWorkspace } = await import("../cloud/onboardingProvisioning");
        await recoverMissingOnboardingWorkspace({
          hasUsableWorkspace: async () => {
            const hasWorkspace = await hasUsableOnboardingWorkspace({
              convexUrl,
              fetchToken: options.fetchToken,
            });
            return cancelled ? true : hasWorkspace;
          },
          restartOnboarding: async () => {
            if (cancelled) return;
            await user.update({
              unsafeMetadata: restartOnboardingForWorkspaceRecovery(
                parseProfileMetadata(user.unsafeMetadata),
              ),
            });
          },
        });
      } catch {
        // A failed check must never restart onboarding; the next boot retries.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [convexUrl, options.fetchToken, options.user, validationKey]);
}

function RootRouteContent({ pathname }: { readonly pathname: string }) {
  const { authGateState } = Route.useRouteContext();
  const primaryEnvironmentAuthenticated = authGateState.status === "authenticated";

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      syncBrowserChromeTheme();
    });
    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [pathname]);

  if (
    pathname === "/login" ||
    pathname === "/register" ||
    pathname === "/onboarding" ||
    pathname === "/pair" ||
    pathname === "/connect" ||
    pathname.startsWith("/connect/")
  ) {
    return (
      <>
        <DocumentTitleSync />
        <Outlet />
      </>
    );
  }

  // Every route below this point is server-backed, so an unpaired client has
  // nothing to render: the routes above own the pairing and sign-in surfaces,
  // and the rest would paint their own content with no app shell around it.
  // Pair in place instead of redirecting to `/pair`, so the requested route is
  // still the one that renders once the session exists.
  if (authGateState.status === "requires-auth") {
    return (
      <>
        <DocumentTitleSync />
        <ServerPairingGate
          auth={authGateState.auth}
          {...(authGateState.errorMessage
            ? { initialErrorMessage: authGateState.errorMessage }
            : {})}
        />
      </>
    );
  }

  const appShell = (
    <CommandPalette>
      <AppSidebarLayout>
        <Outlet />
      </AppSidebarLayout>
    </CommandPalette>
  );

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <DocumentTitleSync />
        <GlassAppearanceSync />
        <FontAppearanceSync />
        {primaryEnvironmentAuthenticated ? <AuthenticatedTracingBootstrap /> : null}
        <ConnectOnboardingDialog />
        <SshPasswordPromptDialog />
        <ConfirmDialogHost />
        {/* A rootless project prompts for a directory just in time, from anywhere in the app. */}
        <AttachProjectDirectoryHost />
        {/* Every project needs an owning company before it can carry issues. */}
        {primaryEnvironmentAuthenticated ? <AssignProjectCompanyDialog /> : null}
        <SlowRpcRequestToastCoordinator />
        <PullRequestAgentReviewHost />
        <HostedStaticEnvironmentBootstrap />
        {primaryEnvironmentAuthenticated ? <EventRouter /> : null}
        {/* Captured mail toasts from any route, so a verification code finds you mid-thread. */}
        {primaryEnvironmentAuthenticated ? <EmailCaptureToastHost /> : null}
        {appShell}
        {/* Above the router: a theme draft is judged by walking the app, so the
            editor has to survive navigation away from settings. */}
        <ThemeEditorHost />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

/**
 * The pairing prompt for a client the local environment does not know yet,
 * rendered in place of the route it blocks. Pairing re-runs the root
 * `beforeLoad`, which is what resolves the gate again, so the route this
 * replaced renders with its shell as soon as the session exists.
 */
function ServerPairingGate({
  auth,
  initialErrorMessage,
}: {
  readonly auth: AuthSessionState["auth"];
  readonly initialErrorMessage?: string;
}) {
  const router = useRouter();

  return (
    <PairingRouteSurface
      auth={auth}
      onAuthenticated={() => {
        void router.invalidate();
      }}
      {...(initialErrorMessage ? { initialErrorMessage } : {})}
    />
  );
}

function GlassAppearanceSync() {
  const glassOpacity = useClientSettings((settings) => settings.glassOpacity);

  useEffect(() => {
    document.documentElement.style.setProperty("--glass-opacity", `${glassOpacity}%`);
  }, [glassOpacity]);

  return null;
}

function FontAppearanceSync() {
  const fontFamilySans = useClientSettings((settings) => settings.fontFamilySans);
  const fontFamilyCode = useClientSettings((settings) => settings.fontFamilyCode);
  const fontFamilyComposer = useClientSettings((settings) => settings.fontFamilyComposer);
  const fontSizeInterface = useClientSettings((settings) => settings.fontSizeInterface);
  const fontSizePrompt = useClientSettings((settings) => settings.fontSizePrompt);
  const fontSizeCode = useClientSettings((settings) => settings.fontSizeCode);
  const fontSmoothing = useClientSettings((settings) => settings.fontSmoothing);

  useEffect(() => {
    applyAppearanceFontVariables(document.documentElement, {
      sans: fontFamilySans,
      code: fontFamilyCode,
      composer: fontFamilyComposer,
      sizeInterface: fontSizeInterface,
      sizePrompt: fontSizePrompt,
      sizeCode: fontSizeCode,
      smoothing: fontSmoothing,
    });
  }, [
    fontFamilyCode,
    fontFamilyComposer,
    fontFamilySans,
    fontSizeCode,
    fontSizeInterface,
    fontSizePrompt,
    fontSmoothing,
  ]);

  return null;
}

function DocumentTitleSync() {
  const primaryServerVersion =
    useAtomValue(primaryServerConfigAtom)?.environment.serverVersion ?? null;
  const title = resolveServerBackedAppDisplayName({
    baseName: APP_BASE_NAME,
    fallbackDisplayName: APP_DISPLAY_NAME,
    fallbackStageLabel: APP_STAGE_LABEL,
    primaryServerVersion,
  });

  useEffect(() => {
    document.title = title;
  }, [title]);

  return null;
}

function HostedStaticEnvironmentBootstrap() {
  const { environments } = useEnvironments();
  const activeEnvironmentId = useActiveEnvironmentId();

  useEffect(() => {
    if (
      environments.some(
        (environment) => environment.entry.target._tag === "PrimaryConnectionTarget",
      )
    ) {
      return;
    }

    if (activeEnvironmentId) {
      return;
    }

    const firstSavedEnvironment = environments[0];
    if (!firstSavedEnvironment) {
      return;
    }

    setActiveEnvironmentId(firstSavedEnvironment.environmentId);
  }, [activeEnvironmentId, environments]);

  return null;
}

function RootRouteErrorView({ error, reset }: ErrorComponentProps) {
  const message = errorMessage(error);
  const details = errorDetails(error);

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-10 text-foreground sm:px-6">
      <div className="pointer-events-none absolute inset-0 opacity-80">
        <div className="absolute inset-x-0 top-0 h-44 bg-[radial-gradient(44rem_16rem_at_top,color-mix(in_srgb,var(--color-red-500)_16%,transparent),transparent)]" />
        <div className="absolute inset-0 bg-[linear-gradient(145deg,color-mix(in_srgb,var(--background)_90%,var(--color-black))_0%,var(--background)_55%)]" />
      </div>

      <section className="relative w-full max-w-xl rounded-2xl border border-border/80 bg-card/90 p-6 shadow-2xl shadow-black/20 backdrop-blur-md sm:p-8">
        <p className="text-[11px] font-semibold tracking-[0.18em] text-muted-foreground uppercase">
          {APP_DISPLAY_NAME}
        </p>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
          Something went wrong.
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{message}</p>

        <div className="mt-5 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => reset()}>
            Try again
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
            Reload app
          </Button>
        </div>

        <details className="group mt-5 overflow-hidden rounded-lg border border-border/70 bg-background/55">
          <summary className="cursor-pointer list-none px-3 py-2 text-xs font-medium text-muted-foreground">
            <span className="group-open:hidden">Show error details</span>
            <span className="hidden group-open:inline">Hide error details</span>
          </summary>
          <pre className="max-h-56 overflow-auto border-t border-border/70 bg-background/80 px-3 py-2 text-xs text-foreground/85">
            {details}
          </pre>
        </details>
      </section>
    </div>
  );
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unexpected router error occurred.";
}

function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    return JSON.stringify(error, null, 2);
  } catch {
    return "No additional error details are available.";
  }
}

function AuthenticatedTracingBootstrap() {
  useEffect(() => {
    void configureClientTracing();
  }, []);

  return null;
}

function EventRouter() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const primaryEnvironment = usePrimaryEnvironment();
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, {
    reportFailure: false,
  });
  const serverConfig = useAtomValue(primaryServerConfigAtom);
  const serverConfigEvent = useAtomValue(primaryServerConfigEventAtom);
  const serverWelcome = useAtomValue(primaryServerWelcomeAtom);
  const readPathname = useEffectEvent(() => pathname);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);
  const handledConfigEventRef = useRef(serverConfigEvent);
  const [keybindingsToastController] = useState<KeybindingsUpdateToastController>(() =>
    createKeybindingsUpdateToastController({}),
  );

  const handleWelcome = useEffectEvent((payload: ServerLifecycleWelcomePayload | null) => {
    if (!payload) return;

    setActiveEnvironmentId(payload.environment.environmentId);
    void (async () => {
      if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
        return;
      }
      const bootstrapProject = readProject(
        scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
      );
      const bootstrapProjectKey =
        (bootstrapProject
          ? deriveLogicalProjectKeyFromSettings(bootstrapProject, projectGroupingSettings)
          : null) ??
        (serverConfig?.cwd
          ? derivePhysicalProjectKeyFromPath(payload.environment.environmentId, serverConfig.cwd)
          : null) ??
        scopedProjectKey(
          scopeProjectRef(payload.environment.environmentId, payload.bootstrapProjectId),
        );
      useUiStateStore.getState().setProjectExpanded(bootstrapProjectKey, true);

      if (readPathname() !== "/") {
        return;
      }
      if (handledBootstrapThreadIdRef.current === payload.bootstrapThreadId) {
        return;
      }
      await navigate({
        to: "/threads/$environmentId/$threadId",
        params: {
          environmentId: payload.environment.environmentId,
          threadId: payload.bootstrapThreadId,
        },
        replace: true,
      });
      handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
    })().catch(() => undefined);
  });

  const handleServerConfigUpdated = useEffectEvent(() => {
    const decision = keybindingsToastController.handle(serverConfigEvent);
    if (!decision) {
      return;
    }

    if (decision._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Keybindings updated",
        description: "Keybindings configuration reloaded successfully.",
      });
      return;
    }

    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Invalid keybindings configuration",
        description: decision.message,
        actionVariant: "outline",
        actionProps: {
          children: "Open keybindings.json",
          onClick: () => {
            if (!serverConfig || !primaryEnvironment) {
              return;
            }

            const editor = resolveAndPersistPreferredEditor(serverConfig.availableEditors);
            if (!editor) {
              return;
            }
            void (async () => {
              const result = await openInEditor({
                environmentId: primaryEnvironment.environmentId,
                input: {
                  cwd: serverConfig.keybindingsConfigPath,
                  editor,
                },
              });
              if (result._tag === "Success") {
                return;
              }
              const error = squashAtomCommandFailure(result);
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Unable to open keybindings file",
                  description:
                    error instanceof Error ? error.message : "Unknown error opening file.",
                }),
              );
            })();
          },
        },
      }),
    );
  });

  useEffect(() => {
    if (!serverConfig) {
      return;
    }

    setActiveEnvironmentId(serverConfig.environment.environmentId);
  }, [serverConfig]);

  useEffect(() => {
    handleWelcome(serverWelcome);
  }, [serverWelcome]);

  useEffect(() => {
    if (serverConfigEvent === null || handledConfigEventRef.current === serverConfigEvent) {
      return;
    }
    handledConfigEventRef.current = serverConfigEvent;
    handleServerConfigUpdated();
  }, [serverConfigEvent]);

  return null;
}
