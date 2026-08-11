import { useClerk, useUser } from "@clerk/expo";
import {
  isOnboardingComplete,
  mergeProfileMetadata,
  parseProfileMetadata,
  resolveOnboardingStep,
  type AccountKind,
  type CompanyRole,
  type CompanySize,
  type OnboardingStep,
  type ProviderUsage,
  type ReferralSource,
} from "@t3tools/client-runtime/profile";
import type { UserResource } from "@clerk/expo/types";
import { useCallback, useState } from "react";
import { Alert, View } from "react-native";

import { ErrorBanner } from "../../../components/ErrorBanner";
import { LoadingScreen } from "../../../components/LoadingScreen";
import { AuthButton, AuthLinkButton } from "../components/AuthControls";
import { AuthScreenShell } from "../components/AuthScreenShell";
import { clerkErrorMessage } from "../clerkErrorMessage";
import {
  avatarDataUrl,
  buildCompanyProfile,
  buildIdentityUpdate,
  buildIndividualProfile,
  canContinueIdentity,
  onboardingProgressLabel,
  resolveNextOnboardingStep,
  resolvePreviousOnboardingStep,
  toggleProviderSelection,
} from "../onboarding.logic";
import { OnboardingAccountKindStep } from "./OnboardingAccountKindStep";
import { OnboardingCompanyStep } from "./OnboardingCompanyStep";
import { OnboardingIdentityStep } from "./OnboardingIdentityStep";
import { OnboardingIndividualStep } from "./OnboardingIndividualStep";

async function loadImagePicker() {
  // Matches lib/composerImages.ts: the native module can be missing in
  // non-native environments, so the import failure is a product error rather
  // than a crash.
  try {
    return await import("expo-image-picker");
  } catch (error) {
    throw new Error("The photo library is unavailable right now.", { cause: error });
  }
}

export function OnboardingScreen() {
  const { user } = useUser();
  if (!user) return <LoadingScreen message="Loading your profile" />;
  return <OnboardingStepper user={user} />;
}

/**
 * Blocking, resumable profile stepper (docs/internals/decisions/0004). Each
 * step writes as it completes rather than batching at the end, so a crash or a
 * device switch resumes in place — resumption is read back through the shared
 * `resolveOnboardingStep`.
 *
 * Web stacks the steps as a deck; native uses a single paged card with a
 * "Step n of 3" indicator, which is the platform's natural shape.
 */
function OnboardingStepper({ user }: { readonly user: UserResource }) {
  const { signOut } = useClerk();
  const metadata = parseProfileMetadata(user.unsafeMetadata);

  // Seeded once. `user` mutates under us as each step is written, and the
  // stepper must not jump when it does.
  const [step, setStep] = useState<OnboardingStep>(() =>
    resolveOnboardingStep({ hasName: Boolean(user.firstName), metadata }),
  );
  const [firstName, setFirstName] = useState(user.firstName ?? "");
  const [lastName, setLastName] = useState(user.lastName ?? "");
  const [avatarUri, setAvatarUri] = useState<string | null>(user.hasImage ? user.imageUrl : null);
  const [isPickingAvatar, setIsPickingAvatar] = useState(false);
  const [accountKind, setAccountKind] = useState<AccountKind | null>(metadata?.accountKind ?? null);
  const [companyName, setCompanyName] = useState(metadata?.company?.name ?? "");
  const [companySize, setCompanySize] = useState<CompanySize | null>(
    metadata?.company?.size ?? null,
  );
  const [companyRole, setCompanyRole] = useState<CompanyRole | null>(
    metadata?.company?.role ?? null,
  );
  const [providers, setProviders] = useState<ReadonlyArray<ProviderUsage>>(
    metadata?.individual?.providers ?? [],
  );
  const [referralSource, setReferralSource] = useState<ReferralSource | null>(
    metadata?.individual?.referralSource ?? null,
  );
  const [referralDetail, setReferralDetail] = useState(metadata?.individual?.referralDetail ?? "");
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const handlePickAvatar = useCallback(() => {
    void (async () => {
      setError(null);
      setIsPickingAvatar(true);
      try {
        const imagePicker = await loadImagePicker();
        const result = await imagePicker.launchImageLibraryAsync({
          allowsEditing: true,
          base64: true,
          mediaTypes: ["images"],
          quality: 0.8,
        });
        if (result.canceled) return;
        const asset = result.assets[0];
        if (!asset?.base64) {
          setError("That photo could not be read. Try a different one.");
          return;
        }
        // Clerk hosts the image; we store no blob and serve no file
        // (docs/internals/decisions/0003). The picker returns JPEG base64.
        await user.setProfileImage({ file: avatarDataUrl(asset.base64) });
        setAvatarUri(asset.uri);
      } catch (cause) {
        setError(
          clerkErrorMessage(
            cause,
            cause instanceof Error ? cause.message : "Could not set that photo.",
          ),
        );
      } finally {
        setIsPickingAvatar(false);
      }
    })();
  }, [user]);

  const advanceFrom = useCallback((current: OnboardingStep, kind: AccountKind | null) => {
    const next = resolveNextOnboardingStep(current, kind ?? undefined);
    if (next) setStep(next);
  }, []);

  const handleIdentityContinue = useCallback(() => {
    void (async () => {
      setIsSaving(true);
      setError(null);
      try {
        await user.update(buildIdentityUpdate({ firstName, lastName }));
        advanceFrom("identity", accountKind);
      } catch (cause) {
        setError(clerkErrorMessage(cause, "Could not save your name. Try again."));
      } finally {
        setIsSaving(false);
      }
    })();
  }, [accountKind, advanceFrom, firstName, lastName, user]);

  const handleSelectAccountKind = useCallback(
    (value: AccountKind) => {
      void (async () => {
        setIsSaving(true);
        setError(null);
        setAccountKind(value);
        try {
          // Written immediately, not on continue: resumption reads this back.
          // `updateMetadata` deep-merges, which would corrupt the shrinking
          // `providers` array later in the flow, so the full merged object
          // goes through `update` instead.
          await user.update({
            unsafeMetadata: mergeProfileMetadata(parseProfileMetadata(user.unsafeMetadata), {
              accountKind: value,
            }),
          });
          advanceFrom("account-kind", value);
        } catch (cause) {
          setError(clerkErrorMessage(cause, "Could not save that choice. Try again."));
        } finally {
          setIsSaving(false);
        }
      })();
    },
    [advanceFrom, user],
  );

  const finish = useCallback(
    (options: { readonly skipped: boolean }) => {
      void (async () => {
        setIsSaving(true);
        setError(null);
        const current = parseProfileMetadata(user.unsafeMetadata);
        const branch =
          accountKind === "company"
            ? {
                company: options.skipped
                  ? undefined
                  : buildCompanyProfile({
                      name: companyName,
                      role: companyRole,
                      size: companySize,
                    }),
              }
            : {
                individual: options.skipped
                  ? undefined
                  : buildIndividualProfile({ providers, referralDetail, referralSource }),
              };
        try {
          await user.update({
            unsafeMetadata: mergeProfileMetadata(current, {
              ...branch,
              onboardingCompletedAt: new Date().toISOString(),
            }),
          });
          // No navigation: the gate observes `onboardingCompletedAt` and hands
          // the app over on the next render.
        } catch (cause) {
          setError(clerkErrorMessage(cause, "Could not finish setting up. Try again."));
          setIsSaving(false);
        }
      })();
    },
    [
      accountKind,
      companyName,
      companyRole,
      companySize,
      providers,
      referralDetail,
      referralSource,
      user,
    ],
  );

  const handleBack = useCallback(() => {
    const previous = resolvePreviousOnboardingStep(step);
    if (previous) setStep(previous);
  }, [step]);

  const handleSignOut = useCallback(() => {
    Alert.alert("Sign out?", "You can finish setting up next time you sign in.", [
      { style: "cancel", text: "Stay" },
      {
        style: "destructive",
        text: "Sign out",
        onPress: () => {
          void signOut();
        },
      },
    ]);
  }, [signOut]);

  // A completed profile that has not yet been picked up by the gate should not
  // flash the last step back at the user.
  if (isOnboardingComplete(metadata)) {
    return <LoadingScreen message="Setting up your workspace" />;
  }

  return (
    <AuthScreenShell
      onBack={resolvePreviousOnboardingStep(step) ? handleBack : undefined}
      progressLabel={onboardingProgressLabel(step)}
      subtitle={SUBTITLE_BY_STEP[step]}
      title={TITLE_BY_STEP[step]}
      footer={
        <View collapsable={false} className="gap-2">
          {error ? <ErrorBanner message={error} /> : null}
          {step === "identity" ? (
            <AuthButton
              busy={isSaving}
              disabled={isSaving || isPickingAvatar || !canContinueIdentity(firstName)}
              label="Continue"
              onPress={handleIdentityContinue}
            />
          ) : null}
          {step === "company-details" || step === "individual-details" ? (
            <>
              <AuthButton
                busy={isSaving}
                disabled={isSaving}
                label="Finish"
                onPress={() => finish({ skipped: false })}
              />
              <AuthLinkButton
                disabled={isSaving}
                label="Skip for now"
                onPress={() => finish({ skipped: true })}
              />
            </>
          ) : null}
          {step === "account-kind" ? (
            <AuthLinkButton disabled={isSaving} label="Sign out" onPress={handleSignOut} />
          ) : null}
        </View>
      }
    >
      {step === "identity" ? (
        <OnboardingIdentityStep
          avatarUri={avatarUri}
          firstName={firstName}
          isPickingAvatar={isPickingAvatar}
          lastName={lastName}
          onChangeFirstName={setFirstName}
          onChangeLastName={setLastName}
          onPickAvatar={handlePickAvatar}
        />
      ) : null}

      {step === "account-kind" ? (
        <OnboardingAccountKindStep
          disabled={isSaving}
          onSelect={handleSelectAccountKind}
          selected={accountKind}
        />
      ) : null}

      {step === "company-details" ? (
        <OnboardingCompanyStep
          name={companyName}
          onChangeName={setCompanyName}
          onChangeRole={setCompanyRole}
          onChangeSize={setCompanySize}
          role={companyRole}
          size={companySize}
        />
      ) : null}

      {step === "individual-details" ? (
        <OnboardingIndividualStep
          onChangeReferralDetail={setReferralDetail}
          onChangeReferralSource={setReferralSource}
          onToggleProvider={(value) =>
            setProviders((current) => toggleProviderSelection(current, value))
          }
          providers={providers}
          referralDetail={referralDetail}
          referralSource={referralSource}
        />
      ) : null}
    </AuthScreenShell>
  );
}

const TITLE_BY_STEP: Record<OnboardingStep, string> = {
  identity: "What should we call you?",
  "account-kind": "How will you use Pathway?",
  "company-details": "Tell us about your team",
  "individual-details": "A couple of quick questions",
};

const SUBTITLE_BY_STEP: Record<OnboardingStep, string> = {
  identity: "Your name and photo travel with your account, on every device.",
  "account-kind": "This only changes what we ask next.",
  "company-details": "All optional — skip any of it.",
  "individual-details": "All optional — skip any of it.",
};
