import {
  mergeProfileMetadata,
  parseProfileMetadata,
  resolveOnboardingStep,
  type AccountKind,
  type CompanyRole,
  type CompanySize,
  type OnboardingStep,
  type ProfileMetadata,
  type ProviderUsage,
  type ReferralSource,
} from "@spiritdevs/client-runtime/profile";
import { useAuth, useUser } from "@clerk/react";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useState } from "react";

import { clerkErrorMessage } from "~/components/auth/clerkErrorMessage";
import { resolveCloudSyncConvexUrl, resolveConvexClerkTokenOptions } from "~/cloud/publicConfig";
import { AccountKindStep } from "./AccountKindStep";
import { CompanyDetailsStep } from "./CompanyDetailsStep";
import { IdentityStep } from "./IdentityStep";
import { IndividualDetailsStep } from "./IndividualDetailsStep";
import { StackedStepCards } from "./StackedStepCards";
import {
  branchStepForAccountKind,
  buildCompanyPatch,
  buildIndividualPatch,
  canContinueFromIdentity,
  onboardingPeekLayerCount,
  onboardingStepAnnouncement,
  previousOnboardingStep,
  resolveStepperArrowIntent,
  shouldIgnoreStepperKeyEvent,
  toggleProfileChip,
  toggleSingleChoice,
} from "./onboardingStepper.logic";

/**
 * The signed-in Clerk user, taken from the hook's own union so this file does
 * not have to depend on `@clerk/shared/types` directly.
 */
export type SignedInClerkUser = Extract<ReturnType<typeof useUser>, { isSignedIn: true }>["user"];

type ProfilePatch = Partial<Omit<ProfileMetadata, "v">>;

class WorkspaceProvisioningError extends Error {}

/**
 * The blocking profile stepper (docs/internals/decisions/0004). Where the user
 * resumes comes from the Clerk user; from then on local state drives the deck,
 * and every completed step is written to `unsafeMetadata` immediately rather
 * than batched, so a refresh or a device switch picks up in place.
 */
export function OnboardingStepper({ user }: { readonly user: SignedInClerkUser }) {
  const navigate = useNavigate();
  const { getToken } = useAuth();
  const metadata = parseProfileMetadata(user.unsafeMetadata);
  const accountKind = metadata?.accountKind ?? null;

  const [step, setStep] = useState<OnboardingStep>(() =>
    resolveOnboardingStep({
      hasName: Boolean(user.firstName),
      metadata: parseProfileMetadata(user.unsafeMetadata),
    }),
  );
  const [pending, setPending] = useState(false);
  const [pendingKind, setPendingKind] = useState<AccountKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [firstName, setFirstName] = useState(() => user.firstName ?? "");
  const [lastName, setLastName] = useState(() => user.lastName ?? "");
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [stagedAvatarUrl, setStagedAvatarUrl] = useState<string | null>(null);

  const [companyName, setCompanyName] = useState(() => metadata?.company?.name ?? "");
  const [companySize, setCompanySize] = useState<CompanySize | null>(
    () => metadata?.company?.size ?? null,
  );
  const [companyRole, setCompanyRole] = useState<CompanyRole | null>(
    () => metadata?.company?.role ?? null,
  );

  const [providers, setProviders] = useState<ReadonlyArray<ProviderUsage>>(
    () => metadata?.individual?.providers ?? [],
  );
  const [referralSource, setReferralSource] = useState<ReferralSource | null>(
    () => metadata?.individual?.referralSource ?? null,
  );
  const [referralDetail, setReferralDetail] = useState(
    () => metadata?.individual?.referralDetail ?? "",
  );

  useEffect(() => {
    if (avatarFile === null) {
      setStagedAvatarUrl(null);
      return;
    }
    const url = URL.createObjectURL(avatarFile);
    setStagedAvatarUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [avatarFile]);

  const avatarPreviewUrl = stagedAvatarUrl ?? (user.hasImage ? user.imageUrl : null);
  const canAdvance =
    step === "identity"
      ? canContinueFromIdentity(firstName)
      : step === "account-kind"
        ? accountKind !== null
        : false;

  async function runWrite(action: () => Promise<void>, fallbackMessage: string): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(
        cause instanceof WorkspaceProvisioningError
          ? cause.message
          : clerkErrorMessage(cause, fallbackMessage),
      );
    } finally {
      setPending(false);
    }
  }

  /**
   * `user.updateMetadata` deep-merges, which would make an array answer such as
   * `individual.providers` impossible to shrink. The document computed here is
   * already complete, so the full replace `user.update` performs is the honest
   * write.
   */
  async function writeProfileMetadata(patch: ProfilePatch): Promise<void> {
    await user.update({
      unsafeMetadata: mergeProfileMetadata(parseProfileMetadata(user.unsafeMetadata), patch),
    });
  }

  function handleBack() {
    const previous = previousOnboardingStep(step);
    if (previous === null) return;
    setError(null);
    setStep(previous);
  }

  function handleIdentityContinue() {
    if (!canContinueFromIdentity(firstName)) return;
    void runWrite(async () => {
      if (avatarFile !== null) {
        await user.setProfileImage({ file: avatarFile });
        setAvatarFile(null);
      }
      await user.update({ firstName: firstName.trim(), lastName: lastName.trim() });
      setStep("account-kind");
    }, "We could not save your details. Check your connection and try again.");
  }

  function handleAvatarRemoved() {
    if (avatarFile !== null) {
      setAvatarFile(null);
      return;
    }
    void runWrite(async () => {
      await user.setProfileImage({ file: null });
    }, "We could not remove that photo. Try again.");
  }

  async function selectAccountKind(nextKind: AccountKind) {
    setPendingKind(nextKind);
    await runWrite(async () => {
      await writeProfileMetadata({ accountKind: nextKind });
      setStep(branchStepForAccountKind(nextKind));
    }, "We could not save that choice. Check your connection and try again.");
    setPendingKind(null);
  }

  function completeOnboarding(
    accountKind: AccountKind,
    patch: ProfilePatch,
    workspaceName: string,
  ) {
    void runWrite(async () => {
      const convexUrl = resolveCloudSyncConvexUrl();
      if (convexUrl === null) {
        throw new Error("Workspace provisioning is not configured for this Pathway build.");
      }
      const {
        completeOnboardingAfterWorkspaceProvision,
        onboardingProvisioningErrorMessage,
        onboardingWorkspaceProvisioningArgs,
        provisionOnboardingWorkspace,
      } = await import("~/cloud/onboardingProvisioning");
      try {
        await completeOnboardingAfterWorkspaceProvision({
          provisionWorkspace: () =>
            provisionOnboardingWorkspace({
              convexUrl,
              fetchToken: () => getToken(resolveConvexClerkTokenOptions()),
              args: onboardingWorkspaceProvisioningArgs(accountKind, workspaceName),
            }),
          persistCompletedProfile: () =>
            writeProfileMetadata({ ...patch, onboardingCompletedAt: new Date().toISOString() }),
          navigateHome: () => navigate({ replace: true, to: "/" }),
        });
      } catch (cause) {
        throw new WorkspaceProvisioningError(onboardingProvisioningErrorMessage(cause), {
          cause,
        });
      }
    }, "We could not finish setting up your account. Try again.");
  }

  function handleCompanyFinish() {
    const company = buildCompanyPatch({
      name: companyName,
      role: companyRole,
      size: companySize,
    });
    completeOnboarding("company", company === null ? {} : { company }, companyName);
  }

  function handleIndividualFinish() {
    const individual = buildIndividualPatch({ providers, referralDetail, referralSource });
    completeOnboarding("individual", individual === null ? {} : { individual }, "");
  }

  function handleSkipBranch() {
    if (accountKind !== null) completeOnboarding(accountKind, {}, companyName);
  }

  const handleArrowKey = useEffectEvent((event: KeyboardEvent) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      shouldIgnoreStepperKeyEvent({
        isContentEditable: target.isContentEditable,
        tagName: target.tagName,
      })
    ) {
      return;
    }
    const intent = resolveStepperArrowIntent({
      canAdvance,
      isPending: pending,
      key: event.key,
      step,
    });
    if (intent === null) return;
    event.preventDefault();
    if (intent === "back") {
      handleBack();
      return;
    }
    if (step === "identity") {
      handleIdentityContinue();
      return;
    }
    if (accountKind !== null) {
      setStep(branchStepForAccountKind(accountKind));
    }
  });

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      handleArrowKey(event);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  return (
    <StackedStepCards
      announcement={onboardingStepAnnouncement(step)}
      peekCount={onboardingPeekLayerCount(step)}
      stepId={step}
    >
      {step === "identity" ? (
        <IdentityStep
          avatarPreviewUrl={avatarPreviewUrl}
          error={error}
          firstName={firstName}
          lastName={lastName}
          onAvatarFileSelected={setAvatarFile}
          onAvatarRemoved={handleAvatarRemoved}
          onContinue={handleIdentityContinue}
          onFirstNameChange={setFirstName}
          onLastNameChange={setLastName}
          pending={pending}
        />
      ) : step === "account-kind" ? (
        <AccountKindStep
          error={error}
          onBack={handleBack}
          onSelect={(nextKind) => {
            void selectAccountKind(nextKind);
          }}
          pending={pending}
          pendingKind={pendingKind}
          selected={accountKind}
        />
      ) : step === "company-details" ? (
        <CompanyDetailsStep
          error={error}
          name={companyName}
          onBack={handleBack}
          onFinish={handleCompanyFinish}
          onNameChange={setCompanyName}
          onRoleToggle={(value) => setCompanyRole((current) => toggleSingleChoice(current, value))}
          onSizeToggle={(value) => setCompanySize((current) => toggleSingleChoice(current, value))}
          onSkip={handleSkipBranch}
          pending={pending}
          role={companyRole}
          size={companySize}
        />
      ) : (
        <IndividualDetailsStep
          error={error}
          onBack={handleBack}
          onFinish={handleIndividualFinish}
          onProviderToggle={(value) => setProviders((current) => toggleProfileChip(current, value))}
          onReferralDetailChange={setReferralDetail}
          onReferralSourceToggle={(value) =>
            setReferralSource((current) => toggleSingleChoice(current, value))
          }
          onSkip={handleSkipBranch}
          pending={pending}
          providers={providers}
          referralDetail={referralDetail}
          referralSource={referralSource}
        />
      )}
    </StackedStepCards>
  );
}
