import { useAuth, useUser } from "@clerk/expo";
import { isOnboardingComplete, parseProfileMetadata } from "@t3tools/client-runtime/profile";
import type { ReactNode } from "react";
import { StatusBar, View, useColorScheme } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { BrandMark } from "../../components/BrandMark";
import { LoadingScreen } from "../../components/LoadingScreen";
import { hasClerkPublicConfig } from "../cloud/publicConfig";
import { AuthFlowScreen } from "./AuthFlowScreen";
import { OnboardingScreen } from "./onboarding/OnboardingScreen";
import { resolveMobileAuthGateState } from "./authGate.logic";
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
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const onboardingComplete =
    isSignedIn && user
      ? isOnboardingComplete(parseProfileMetadata(user.unsafeMetadata))
      : undefined;

  const state = resolveMobileAuthGateState({
    hasClerkConfig: true,
    isLoaded,
    isSignedIn,
    onboardingComplete,
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
        <Text className="text-xl font-t3-bold tracking-[-0.4px] text-foreground">
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
