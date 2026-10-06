import { AgentCursorDesktopSync } from "../components/settings/agentCursorDesktopSync";
import { DictationAccountCoordinator } from "../dictation/cloud";
import { type ServerLifecycleWelcomePayload } from "@spiritdevs/contracts";
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
import { lazy, Suspense, useCallback, useEffect, useEffectEvent, useRef, useState } from "react";

import { APP_BASE_NAME, APP_DISPLAY_NAME, APP_STAGE_LABEL } from "../branding";
import { resolveServerBackedAppDisplayName } from "../branding.logic";
import {
  hasClerkPublicConfig,
  resolveCloudSyncConvexUrl,
  resolveConvexClerkTokenOptions,
} from "../cloud/publicConfig";
import { AppSidebarLayout, WorkspaceFrame } from "../components/AppSidebarLayout";
import { OrchestratorProvider } from "../components/orchestrator/OrchestratorProvider";
import { PairingRouteSurface } from "../components/auth/PairingRouteSurface";
import { CommandPalette } from "../components/CommandPalette";
import { ThreadParentDialog } from "../components/chat/ThreadParentDialog";
import { TemporaryThreadDiscardDialog } from "../components/TemporaryThreadDiscardDialog";
import { WorkspaceCleanupNoticeHost } from "../components/WorkspaceCleanupNoticeHost";
import { ConfirmDialogHost } from "../components/ConfirmDialogHost";
import { PullRequestAgentReviewHost } from "../components/pullRequest/PullRequestAgentReviewHost";
import { AssignPersonalProjectOwnership } from "../components/projects/AssignPersonalProjectOwnership";
import { RecordEnvironmentOwner } from "../components/auth/RecordEnvironmentOwner";
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
import { CalendarAlertHost } from "../components/calendar/calendarAlerts";
import { ThreadAlertRuntime } from "../threadAlerts/ThreadAlertRuntime";
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
import { readConnectionAccountScope } from "../connection/accountScope";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import {
  resolveInitialPrimaryEnvironmentDescriptor,
  resolveInitialServerAuthGateState,
} from "../environments/primary";
import {
  hasHostedPairingRequest,
  isHostedStaticApp,
  runsWithoutServingEnvironment,
} from "../hostedPairing";
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
import { useSidePaneId } from "../panes/paneScope";
import { ChildWindowSync } from "../panes/ChildWindowSync";
import { isChildWindow } from "../panes/windowMode";
import { isElectron } from "../env";

// Screenshot capture needs the desktop bridge, so the web entry never loads it.
const SnapShotCoordinator = lazy(() =>
  import("../components/desktop/SnapShotCoordinator").then((module) => ({
    default: module.SnapShotCoordinator,
  })),
);

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

    if (isHostedStaticApp(new URL(window.location.href)) || runsWithoutServingEnvironment()) {
      return {
        authGateState: {
          status: "hosted-static",
        } as const,
      };
    }

    if (location.pathname === "/pair") {
      return { authGateState: await resolveInitialServerAuthGateState() };
    }

    return { authGateState: { status: "pending" } as const };
  },
  component: RootRouteView,
  errorComponent: RootRouteErrorView,
  // Clerk gates the shell; environment authentication continues after it mounts.
  pendingComponent: EnvironmentPendingView,
  pendingMs: 0,
  pendingMinMs: 0,
  head: () => ({
    meta: [{ name: "title", content: APP_DISPLAY_NAME }],
  }),
});

function EnvironmentPendingView() {
  // A side pane waits inside its own frame; the boot splash fills the whole window.
  const sidePaneId = useSidePaneId();
  return sidePaneId === null ? <SplashScreen reason="environment" /> : null;
}

function RootRouteView() {
  const sidePaneId = useSidePaneId();
  const pathname = useLocation({ select: (location) => location.pathname });

  // A side pane renders only its page and sidebar: the primary pane already
  // mounts the auth gate, the app shell, and every global host around it.
  if (sidePaneId !== null) {
    return (
      <WorkspaceFrame>
        <Outlet />
      </WorkspaceFrame>
    );
  }

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
  const { getToken, isLoaded, isSignedIn, userId } = useAuth({ treatPendingAsSignedOut: false });
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

  useEffect(() => {
    if (gateState === "redirect") {
      void navigate({ replace: true, to: "/login" }).catch(() => undefined);
    }
    if (gateState === "onboarding") {
      void navigate({ replace: true, to: "/onboarding" }).catch(() => undefined);
    }
  }, [gateState, navigate]);

  const loadingReason = resolveAuthGateLoadingReason({ gateState, isLoaded });
  if (loadingReason) {
    return <SplashScreen reason={loadingReason} />;
  }
  const connectionAccount = readConnectionAccountScope();
  if (isSignedIn && connectionAccount !== null && connectionAccount !== userId) {
    return <SplashScreen reason="environment" />;
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
  const [serverGate, setServerGate] = useState<Awaited<
    ReturnType<typeof resolveInitialServerAuthGateState>
  > | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [authAttempt, retryAuth] = useState(0);
  const retryPrimaryConnection = useAtomCommand(environmentCatalog.retryNow);
  useEffect(() => {
    if (authGateState.status !== "pending") return;
    let active = true;
    setServerError(null);
    void resolveInitialServerAuthGateState()
      .then((gate) => {
        if (!active) return;
        setServerGate(gate);
        if (gate.status === "authenticated") {
          void resolveInitialPrimaryEnvironmentDescriptor().catch(() => undefined);
        }
      })
      .catch((error: unknown) => {
        if (active)
          setServerError(
            error instanceof Error ? error.message : "Could not connect to the environment.",
          );
      });
    return () => {
      active = false;
    };
  }, [authGateState.status, authAttempt]);
  const primaryEnvironmentAuthenticated =
    serverGate?.status === "authenticated" || authGateState.status === "authenticated";

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

  if (serverGate?.status === "requires-auth") {
    return (
      <>
        <DocumentTitleSync />
        <ServerPairingGate
          onAuthenticated={() => {
            setServerGate(null);
            retryAuth((attempt) => attempt + 1);
            const environmentId = appAtomRegistry.get(primaryEnvironmentIdAtom);
            if (environmentId !== null) void retryPrimaryConnection(environmentId);
          }}
        />
      </>
    );
  }

  const appShell = (
    <OrchestratorProvider>
      <CommandPalette>
        <AppSidebarLayout>
          <Outlet />
        </AppSidebarLayout>
        <ThreadParentDialog />
      </CommandPalette>
    </OrchestratorProvider>
  );

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        <DocumentTitleSync />
        <GlassAppearanceSync />
        <FontAppearanceSync />
        {isChildWindow ? null : <AgentCursorDesktopSync />}
        {primaryEnvironmentAuthenticated ? <AuthenticatedTracingBootstrap /> : null}
        {isChildWindow ? null : <ConnectOnboardingDialog />}
        <SshPasswordPromptDialog />
        {isChildWindow || !isElectron ? null : (
          <Suspense fallback={null}>
            <SnapShotCoordinator />
          </Suspense>
        )}
        {isChildWindow ? null : <DictationAccountCoordinator />}
        <ConfirmDialogHost />
        <TemporaryThreadDiscardDialog />
        <WorkspaceCleanupNoticeHost />
        {/* A rootless project prompts for a directory just in time, from anywhere in the app. */}
        <AttachProjectDirectoryHost />
        {/* Every project needs an owning company before it can carry issues. */}
        {primaryEnvironmentAuthenticated && !isChildWindow ? (
          <AssignPersonalProjectOwnership />
        ) : null}
        {primaryEnvironmentAuthenticated && isElectron && !isChildWindow ? (
          <RecordEnvironmentOwner />
        ) : null}
        <SlowRpcRequestToastCoordinator />
        <PullRequestAgentReviewHost />
        <HostedStaticEnvironmentBootstrap />
        {primaryEnvironmentAuthenticated ? <EventRouter /> : null}
        {/* Alerts belong to the main window alone, so a torn-out window never repeats them. */}
        {/* Captured mail toasts from any route, so a verification code finds you mid-thread. */}
        {primaryEnvironmentAuthenticated && !isChildWindow ? <EmailCaptureToastHost /> : null}
        {primaryEnvironmentAuthenticated && !isChildWindow ? <CalendarAlertHost /> : null}
        {primaryEnvironmentAuthenticated && !isChildWindow ? <ThreadAlertRuntime /> : null}
        {authGateState.status === "pending" && !serverError ? (
          <EnvironmentConnectionNotice />
        ) : null}
        {serverError ? (
          <div role="alert" className="px-4 py-2 text-sm">
            {serverError}{" "}
            <Button size="sm" onClick={() => retryAuth((attempt) => attempt + 1)}>
              Retry connection
            </Button>
          </div>
        ) : null}
        {appShell}
        {/* Above the router: a theme draft is judged by walking the app, so the
            editor has to survive navigation away from settings. */}
        <ThemeEditorHost />
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

function EnvironmentConnectionNotice() {
  const environment = usePrimaryEnvironment();
  if (environment?.connection.phase === "connected") return null;
  return (
    <div role="status" className="px-4 py-2 text-sm text-muted-foreground">
      {environment?.connection.error ?? "Connecting to the environment."} Server actions will be
      available when it is ready.
    </div>
  );
}

/** Pair in place, then retry environment authentication without losing the requested route. */
function ServerPairingGate({ onAuthenticated }: { readonly onAuthenticated: () => void }) {
  const router = useRouter();

  return (
    <PairingRouteSurface
      onAuthenticated={() => {
        onAuthenticated();
        void router.invalidate();
      }}
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
    if (!isChildWindow) document.title = title;
  }, [title]);

  // A torn-out window titles itself after its page.
  return isChildWindow ? <ChildWindowSync appName={title} /> : null;
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

      // A torn-out window shows the page it was opened on, even the dashboard.
      if (isChildWindow || readPathname() !== "/") {
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
