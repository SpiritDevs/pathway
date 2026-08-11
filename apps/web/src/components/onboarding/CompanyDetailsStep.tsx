import {
  COMPANY_ROLE_OPTIONS,
  COMPANY_SIZE_OPTIONS,
  type CompanyRole,
  type CompanySize,
} from "@t3tools/client-runtime/profile";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Spinner } from "~/components/ui/spinner";
import { OptionChip, OptionChipGroup } from "./OptionChip";
import { StepBody, StepControls, StepHeader } from "./StackedStepCards";
import { ONBOARDING_STEP_DESCRIPTIONS, ONBOARDING_STEP_TITLES } from "./onboardingStepper.logic";

/**
 * The company branch. Every field here is optional — "Skip for now" completes
 * onboarding without writing any of it.
 */
export function CompanyDetailsStep({
  error,
  name,
  onBack,
  onFinish,
  onNameChange,
  onRoleToggle,
  onSizeToggle,
  onSkip,
  pending,
  role,
  size,
}: {
  readonly error: string | null;
  readonly name: string;
  readonly onBack: () => void;
  readonly onFinish: () => void;
  readonly onNameChange: (value: string) => void;
  readonly onRoleToggle: (value: CompanyRole) => void;
  readonly onSizeToggle: (value: CompanySize) => void;
  readonly onSkip: () => void;
  readonly pending: boolean;
  readonly role: CompanyRole | null;
  readonly size: CompanySize | null;
}) {
  return (
    <>
      <StepBody>
        <StepHeader
          description={ONBOARDING_STEP_DESCRIPTIONS["company-details"]}
          title={ONBOARDING_STEP_TITLES["company-details"]}
        />

        <div className="grid gap-7">
          <div className="grid gap-2">
            <Label htmlFor="onboarding-company-name">
              Company name
              <span className="font-normal text-muted-foreground">Optional</span>
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

          <OptionChipGroup label="How big is the team?">
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
        </div>
      </StepBody>

      <StepControls error={error}>
        <Button disabled={pending} onClick={onBack} size="lg" variant="ghost">
          Back
        </Button>
        <div className="flex items-center gap-2">
          <Button disabled={pending} onClick={onSkip} size="lg" variant="ghost">
            Skip for now
          </Button>
          <Button disabled={pending} onClick={onFinish} size="lg">
            {pending ? <Spinner className="size-4" /> : null}
            Finish
          </Button>
        </div>
      </StepControls>
    </>
  );
}
