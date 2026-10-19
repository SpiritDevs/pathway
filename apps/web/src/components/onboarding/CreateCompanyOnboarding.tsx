import {
  mergeProfileMetadata,
  parseProfileMetadata,
  type CompanyRole,
  type CompanySize,
  type ReferralSource,
} from "@spiritdevs/client-runtime/profile";
import type { CurrentCompanySummary } from "~/cloud/companyAdmin";
import { CompanyId } from "@spiritdevs/contracts/company";
import { useCanGoBack, useNavigate } from "@tanstack/react-router";
import { useRef, useState } from "react";

import { newCompanyDomainId } from "~/cloud/companyAdmin";
import { useCompanySettings } from "~/components/settings/company/useCompanySettings";
import { CompanyDetailsStep } from "./CompanyDetailsStep";
import { StackedStepCards } from "./StackedStepCards";
import { buildCompanyPatch, toggleSingleChoice } from "./onboardingStepper.logic";
import type { SignedInClerkUser } from "./OnboardingStepper";

export function CreateCompanyOnboarding({ user }: { readonly user: SignedInClerkUser }) {
  const navigate = useNavigate();
  const canGoBack = useCanGoBack();
  const companySettings = useCompanySettings();
  const companyIdRef = useRef(CompanyId.make(newCompanyDomainId()));
  const createdCompanyRef = useRef<CurrentCompanySummary | null>(null);

  const [name, setName] = useState("");
  const [size, setSize] = useState<CompanySize | null>(null);
  const [role, setRole] = useState<CompanyRole | null>(null);
  const [referralSource, setReferralSource] = useState<ReferralSource | null>(null);
  const [referralDetail, setReferralDetail] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const goBack = () => {
    if (canGoBack) {
      window.history.back();
      return;
    }
    void navigate({ to: "/" });
  };

  const createCompany = () => {
    const admin = companySettings.admin;
    const profile = buildCompanyPatch({ name, size, role, referralSource, referralDetail });
    if (admin === null || profile === null || profile.name.length === 0 || pending) return;

    setPending(true);
    setError(null);
    void (async () => {
      try {
        const company =
          createdCompanyRef.current ??
          (await admin.createCompany({ id: companyIdRef.current, name: profile.name }));
        createdCompanyRef.current = company;
        await user.update({
          unsafeMetadata: mergeProfileMetadata(parseProfileMetadata(user.unsafeMetadata), {
            company: profile,
          }),
        });
        companySettings.setSettingsCompanyScope(company.id);
        await navigate({ replace: true, to: "/settings/company-members" });
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not create this company.");
      } finally {
        setPending(false);
      }
    })();
  };

  return (
    <StackedStepCards announcement="Create a company" peekCount={0} stepId="create-company">
      <CompanyDetailsStep
        error={error}
        name={name}
        onBack={goBack}
        onFinish={createCompany}
        onNameChange={setName}
        onReferralDetailChange={setReferralDetail}
        onReferralSourceToggle={(value) =>
          setReferralSource((current) => toggleSingleChoice(current, value))
        }
        onRoleToggle={(value) => setRole((current) => toggleSingleChoice(current, value))}
        onSizeToggle={(value) => setSize((current) => toggleSingleChoice(current, value))}
        pending={pending}
        referralDetail={referralDetail}
        referralSource={referralSource}
        role={role}
        size={size}
        variant="create"
      />
    </StackedStepCards>
  );
}
