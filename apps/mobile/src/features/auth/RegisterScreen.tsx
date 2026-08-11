import { useSignUp } from "@clerk/expo/legacy";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { ErrorBanner } from "../../components/ErrorBanner";
import { AuthButton, AuthCard, AuthField, AuthLinkButton } from "./components/AuthControls";
import { AuthScreenShell } from "./components/AuthScreenShell";
import { canSubmitRegistration, MINIMUM_PASSWORD_LENGTH } from "./authFlow.logic";
import { clerkErrorMessage } from "./clerkErrorMessage";

/**
 * Registration step one: create the sign-up attempt and send the email code.
 * The code itself is entered on {@link VerifyEmailScreen}, which reuses the
 * same client-level `signUp` resource.
 *
 * Clerk bot protection has no widget to mount on native — the Expo SDK ships
 * no CAPTCHA component — so `signUp.create` either succeeds or surfaces
 * `captcha_invalid` through the shared error table.
 */
export function RegisterScreen(props: {
  readonly initialEmailAddress: string;
  readonly onBack: () => void;
  readonly onVerificationSent: (emailAddress: string) => void;
  readonly onSignIn: (emailAddress: string) => void;
}) {
  const { isLoaded, signUp } = useSignUp();
  const [emailAddress, setEmailAddress] = useState(props.initialEmailAddress);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = useCallback(() => {
    if (!isLoaded) return;
    void (async () => {
      setIsSubmitting(true);
      setError(null);
      const trimmedEmail = emailAddress.trim();
      try {
        await signUp.create({ emailAddress: trimmedEmail, password });
        await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
        props.onVerificationSent(trimmedEmail);
      } catch (cause) {
        setError(
          clerkErrorMessage(cause, "Could not create the account. Check your details and retry."),
        );
      } finally {
        setIsSubmitting(false);
      }
    })();
  }, [emailAddress, isLoaded, password, props, signUp]);

  return (
    <AuthScreenShell
      onBack={props.onBack}
      title="Create an account"
      subtitle="Your profile and workspace travel with the account, on every device."
      footer={
        <View collapsable={false} className="items-center gap-1">
          <Text className="text-sm text-foreground-muted">Already have an account?</Text>
          <AuthLinkButton label="Sign in instead" onPress={() => props.onSignIn(emailAddress)} />
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
          hint={`At least ${MINIMUM_PASSWORD_LENGTH} characters.`}
          inputProps={{
            autoCapitalize: "none",
            autoComplete: "new-password",
            autoCorrect: false,
            onChangeText: setPassword,
            onSubmitEditing: handleSubmit,
            placeholder: "Create a password",
            returnKeyType: "go",
            secureTextEntry: true,
            textContentType: "newPassword",
            value: password,
          }}
        />

        {error ? <ErrorBanner message={error} /> : null}

        <AuthButton
          busy={isSubmitting}
          disabled={!isLoaded || !canSubmitRegistration({ emailAddress, password, isSubmitting })}
          label={isSubmitting ? "Sending code..." : "Continue"}
          onPress={handleSubmit}
        />
      </AuthCard>
    </AuthScreenShell>
  );
}
