import { useAuth, useUser } from "@clerk/expo";
import {
  isOnboardingComplete,
  parseProfileMetadata,
  recoverMissingOnboardingWorkspace,
  restartOnboardingForWorkspaceRecovery,
} from "@spiritdevs/client-runtime/profile";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { StatusBar, View, useColorScheme } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { BrandMark } from "../../components/BrandMark";
import { LoadingScreen } from "../../components/LoadingScreen";
import {
  hasClerkPublicConfig,
  resolveCloudPublicConfig,
  resolveConvexClerkTokenOptions,
} from "../cloud/publicConfig";
import { AuthFlowScreen } from "./AuthFlowScreen";
import { OnboardingScreen } from "./onboarding/OnboardingScreen";
import { resolveMobileAuthGateState, type WorkspaceValidationState } from "./authGate.logic";
import { useThemeColor } from "../../lib/useThemeColor";

/**
 * The single decision about whether this device may reach the app.
 *
 * Accounts are mandatory on every surface (docs/internals/decisions/0001), so
 * the gate swaps the entire tree rather than redirecting: while it is showing
 * auth or onboarding, the root navigator and everything hanging off it (the
 * workspace layout, the outbox drain, agent notifications) is not mounted.
 *
 * Mount point: App.tsx, inside CloudAuthProvider (which owns ClerkProvider)
 * and inside SafeAreaProvider/KeyboardProvider, wrapping the navigation tree.
 */
export function AuthGate(props: { readonly children: ReactNode }) {
  // Read outside the Clerk hooks: with no publishable key, CloudAuthProvider
  // never mounts ClerkProvider and the hooks below would throw.
  if (!hasClerkPublicConfig()) return <MissingAuthConfigScreen />;
  return <ConfiguredAuthGate>{props.children}</ConfiguredAuthGate>;
}

function ConfiguredAuthGate(props: { readonly children: ReactNode }) {
  const { getToken, isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const metadata = user ? parseProfileMetadata(user.unsafeMetadata) : null;
  const onboardingComplete = isSignedIn && user ? isOnboardingComplete(metadata) : undefined;
  const fetchConvexToken = useCallback(
    () => getToken(resolveConvexClerkTokenOptions()),
    [getToken],
  );
  const workspaceValidation = useWorkspaceRecoveryValidation({
    enabled: onboardingComplete === true,
    fetchToken: fetchConvexToken,
    user,
  });

  const state = resolveMobileAuthGateState({
    hasClerkConfig: true,
    isLoaded,
    isSignedIn,
    onboardingComplete,
    workspaceValidation,
  });

  switch (state) {
    case "misconfigured":
      return <MissingAuthConfigScreen />;
    case "loading":
      return <LoadingScreen message="Signing you in" />;
    case "auth":
      return <AuthFlowScreen />;
    case "onboarding":
      return <OnboardingScreen />;
    case "authenticated":
      return props.children;
  }
}

interface WorkspaceValidationResult {
  readonly key: string;
  readonly status: Exclude<WorkspaceValidationState, "checking">;
}

/** Mobile mirror of the web recovery check; see the web root for the state-transition rationale. */
function useWorkspaceRecoveryValidation(options: {
  readonly enabled: boolean;
  readonly fetchToken: () => Promise<string | null>;
  readonly user: ReturnType<typeof useUser>["user"];
}): WorkspaceValidationState {
  const convexUrl = resolveCloudPublicConfig().convex.url;
  const completionMarker = options.user
    ? parseProfileMetadata(options.user.unsafeMetadata)?.onboardingCompletedAt
    : undefined;
  const validationKey =
    options.enabled && options.user && completionMarker && convexUrl
      ? `${options.user.id}:${completionMarker}`
      : null;
  const [result, setResult] = useState<WorkspaceValidationResult | null>(null);

  useEffect(() => {
    const user = options.user;
    if (validationKey === null || convexUrl === null || !user) return;
    let cancelled = false;

    void (async () => {
      try {
        const { hasUsableOnboardingWorkspace } = await import("../cloud/onboardingProvisioning");
        const recovery = await recoverMissingOnboardingWorkspace({
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
        if (cancelled) return;
        if (recovery === "valid") {
          setResult({ key: validationKey, status: "valid" });
        }
      } catch {
        if (!cancelled) setResult({ key: validationKey, status: "unavailable" });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [convexUrl, options.fetchToken, options.user, validationKey]);

  if (!options.enabled) return "valid";
  if (convexUrl === null) return "unavailable";
  return result?.key === validationKey ? result.status : "checking";
}

/**
 * Fails closed. A build with no Clerk publishable key is a misconfiguration,
 * not an open app — this is the mobile twin of the web root's
 * `MissingAuthConfigScreen`.
 */
function MissingAuthConfigScreen() {
  const colorScheme = useColorScheme();
  const screenBg = useThemeColor("--color-screen");
  const insets = useSafeAreaInsets();

  return (
    <View
      className="flex-1 items-center justify-center bg-screen px-6"
      style={{ paddingBottom: insets.bottom, paddingTop: insets.top }}
    >
      <StatusBar
        barStyle={colorScheme === "dark" ? "light-content" : "dark-content"}
        backgroundColor={screenBg as string}
        translucent
      />
      <View collapsable={false} className="w-full gap-4 rounded-[24px] bg-card p-6">
        <BrandMark />
        <Text className="text-xl font-pathway-bold tracking-[-0.4px] text-foreground">
          Authentication is not configured.
        </Text>
        <Text className="text-sm leading-normal text-foreground-muted">
          This build has no Clerk publishable key, and Pathway requires an account to run. Set
          PATHWAY_CLERK_PUBLISHABLE_KEY in the repository-root .env and rebuild the app.
        </Text>
      </View>
    </View>
  );
}
