import {
  COMPANY_ROLE_OPTIONS,
  COMPANY_SIZE_OPTIONS,
  REFERRAL_SOURCE_OPTIONS,
  type CompanyRole,
  type CompanySize,
  type ReferralSource,
} from "@spiritdevs/client-runtime/profile";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Spinner } from "~/components/ui/spinner";
import { OptionChip, OptionChipGroup } from "./OptionChip";
import { StepBody, StepControls, StepHeader } from "./StackedStepCards";
import { ONBOARDING_STEP_DESCRIPTIONS, ONBOARDING_STEP_TITLES } from "./onboardingStepper.logic";

/**
 * The company branch shared by first-run onboarding and additional-company creation.
 * First-run answers remain skippable; an additional company requires a name.
 */
export function CompanyDetailsStep({
  error,
  name,
  onBack,
  onFinish,
  onNameChange,
  onReferralDetailChange,
  onReferralSourceToggle,
  onRoleToggle,
  onSizeToggle,
  onSkip,
  pending,
  referralDetail,
  referralSource,
  role,
  size,
  variant = "onboarding",
}: {
  readonly error: string | null;
  readonly name: string;
  readonly onBack: () => void;
  readonly onFinish: () => void;
  readonly onNameChange: (value: string) => void;
  readonly onReferralDetailChange: (value: string) => void;
  readonly onReferralSourceToggle: (value: ReferralSource) => void;
  readonly onRoleToggle: (value: CompanyRole) => void;
  readonly onSizeToggle: (value: CompanySize) => void;
  readonly onSkip?: (() => void) | undefined;
  readonly pending: boolean;
  readonly referralDetail: string;
  readonly referralSource: ReferralSource | null;
  readonly role: CompanyRole | null;
  readonly size: CompanySize | null;
  readonly variant?: "create" | "onboarding";
}) {
  const creating = variant === "create";
  return (
    <>
      <StepBody>
        <StepHeader
          description={
            creating
              ? "Create a separate workspace for its members, issues, and integrations. The extra details help us shape company features."
              : ONBOARDING_STEP_DESCRIPTIONS["company-details"]
          }
          title={creating ? "Create a company" : ONBOARDING_STEP_TITLES["company-details"]}
        />

        <div className="grid gap-7">
          <div className="grid gap-2">
            <Label htmlFor="onboarding-company-name">
              Company name
              {creating ? null : (
                <span className="font-normal text-muted-foreground">Optional</span>
              )}
            </Label>
            <Input
              autoComplete="organization"
              disabled={pending}
              id="onboarding-company-name"
              onValueChange={onNameChange}
              placeholder="Acme"
              value={name}
            />
          </div>

          <OptionChipGroup
            label={creating ? "How many people will use Pathway?" : "How big is the team?"}
          >
            {COMPANY_SIZE_OPTIONS.map((option) => (
              <OptionChip
                disabled={pending}
                key={option.value}
                onPress={() => onSizeToggle(option.value)}
                selected={size === option.value}
              >
                {option.label}
              </OptionChip>
            ))}
          </OptionChipGroup>

          <OptionChipGroup label="What do you do there?">
            {COMPANY_ROLE_OPTIONS.map((option) => (
              <OptionChip
                disabled={pending}
                key={option.value}
                onPress={() => onRoleToggle(option.value)}
                selected={role === option.value}
              >
                {option.label}
              </OptionChip>
            ))}
          </OptionChipGroup>

          <OptionChipGroup label="How did you hear about us?">
            {REFERRAL_SOURCE_OPTIONS.map((option) => (
              <OptionChip
                disabled={pending}
                key={option.value}
                onPress={() => onReferralSourceToggle(option.value)}
                selected={referralSource === option.value}
              >
                {option.label}
              </OptionChip>
            ))}
          </OptionChipGroup>

          {referralSource === "other" ? (
            <div className="grid gap-2">
              <Label htmlFor="onboarding-company-referral-detail">
                Where was it?
                <span className="font-normal text-muted-foreground">Optional</span>
              </Label>
              <Input
                disabled={pending}
                id="onboarding-company-referral-detail"
                onValueChange={onReferralDetailChange}
                placeholder="A conference, a newsletter, a podcast…"
                value={referralDetail}
              />
            </div>
          ) : null}
        </div>
      </StepBody>

      <StepControls error={error}>
        <Button disabled={pending} onClick={onBack} size="lg" variant="ghost">
          Back
        </Button>
        <div className="flex items-center gap-2">
          {onSkip === undefined ? null : (
            <Button disabled={pending} onClick={onSkip} size="lg" variant="ghost">
              Skip for now
            </Button>
          )}
          <Button
            disabled={pending || (creating && name.trim().length === 0)}
            onClick={onFinish}
            size="lg"
          >
            {pending ? <Spinner className="size-4" /> : null}
            {creating ? (pending ? "Creating…" : "Create company") : "Finish"}
          </Button>
        </div>
      </StepControls>
    </>
  );
}
