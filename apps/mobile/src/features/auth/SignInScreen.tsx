import { useSignIn } from "@clerk/expo/legacy";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { AuthButton, AuthCard, AuthField, AuthLinkButton } from "./components/AuthControls";
import { AuthScreenShell } from "./components/AuthScreenShell";
import { canSubmitSignIn } from "./authFlow.logic";
import { clerkErrorMessage } from "./clerkErrorMessage";

/**
 * Email + password sign-in against Clerk's headless hooks
 * (docs/internals/decisions/0002). No OAuth, no passkeys, no MFA: a second
 * factor is reported as unsupported rather than half-handled.
 */
export function SignInScreen(props: {
  readonly initialEmailAddress: string;
  readonly onRegister: (emailAddress: string) => void;
  readonly onForgotPassword: (emailAddress: string) => void;
}) {
  const { isLoaded, signIn, setActive } = useSignIn();
  const [emailAddress, setEmailAddress] = useState(props.initialEmailAddress);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = useCallback(() => {
    if (!isLoaded) return;
    void (async () => {
      setIsSubmitting(true);
      setError(null);
      try {
        const attempt = await signIn.create({
          strategy: "password",
          identifier: emailAddress.trim(),
          password,
        });
        if (attempt.status === "complete") {
          // The gate re-evaluates off the Clerk session; there is nothing to
          // navigate to from here.
          await setActive({ session: attempt.createdSessionId });
          return;
        }
        setError(
          attempt.status === "needs_second_factor"
            ? "This account needs a second factor, which is not supported yet."
            : "Sign in could not be completed. Try again.",
        );
        setIsSubmitting(false);
      } catch (cause) {
        setError(clerkErrorMessage(cause, "Sign in failed. Check your connection and try again."));
        setIsSubmitting(false);
      }
    })();
  }, [emailAddress, isLoaded, password, setActive, signIn]);

  return (
    <AuthScreenShell
      showBrand
      title="Sign in"
      subtitle="Pathway needs an account to run. Sign in to reach your workspace."
      footer={
        <View collapsable={false} className="items-center gap-1">
          <Text className="text-sm text-foreground-muted">New here?</Text>
          <AuthLinkButton
            label="Create an account"
            onPress={() => props.onRegister(emailAddress)}
          />
        </View>
      }
    >
      <AuthCard>
        <AuthField
          label="Email"
          inputProps={{
            autoCapitalize: "none",
            autoComplete: "email",
            autoCorrect: false,
            keyboardType: "email-address",
            onChangeText: setEmailAddress,
            placeholder: "you@example.com",
            textContentType: "emailAddress",
            value: emailAddress,
          }}
        />
        <AuthField
          label="Password"
          inputProps={{
            autoCapitalize: "none",
            autoComplete: "current-password",
            autoCorrect: false,
            onChangeText: setPassword,
            onSubmitEditing: handleSubmit,
            placeholder: "Your password",
            returnKeyType: "go",
            secureTextEntry: true,
            textContentType: "password",
            value: password,
          }}
        />

        {error ? <ErrorBanner message={error} /> : null}

        <AuthButton
          busy={isSubmitting}
          disabled={!isLoaded || !canSubmitSignIn({ emailAddress, password, isSubmitting })}
          label={isSubmitting ? "Signing in..." : "Sign in"}
          onPress={handleSubmit}
        />
        <AuthLinkButton
          label="Forgot your password?"
          onPress={() => props.onForgotPassword(emailAddress)}
        />
      </AuthCard>
    </AuthScreenShell>
  );
}
