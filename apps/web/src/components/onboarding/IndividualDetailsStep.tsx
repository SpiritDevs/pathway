import {
  PROVIDER_USAGE_OPTIONS,
  REFERRAL_SOURCE_OPTIONS,
  type ProviderUsage,
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
 * The individual branch. "Which providers do you use" is setup rather than a
 * survey — it is the answer that can seed first-run provider configuration —
 * but it is still skippable.
 */
export function IndividualDetailsStep({
  error,
  onBack,
  onFinish,
  onProviderToggle,
  onReferralDetailChange,
  onReferralSourceToggle,
  onSkip,
  pending,
  providers,
  referralDetail,
  referralSource,
}: {
  readonly error: string | null;
  readonly onBack: () => void;
  readonly onFinish: () => void;
  readonly onProviderToggle: (value: ProviderUsage) => void;
  readonly onReferralDetailChange: (value: string) => void;
  readonly onReferralSourceToggle: (value: ReferralSource) => void;
  readonly onSkip: () => void;
  readonly pending: boolean;
  readonly providers: ReadonlyArray<ProviderUsage>;
  readonly referralDetail: string;
  readonly referralSource: ReferralSource | null;
}) {
  return (
    <>
      <StepBody>
        <StepHeader
          description={ONBOARDING_STEP_DESCRIPTIONS["individual-details"]}
          title={ONBOARDING_STEP_TITLES["individual-details"]}
        />

        <div className="grid gap-7">
          <OptionChipGroup
            hint="Pick as many as you like. We use this to set up your first run."
            label="Which coding agents do you use today?"
          >
            {PROVIDER_USAGE_OPTIONS.map((option) => (
              <OptionChip
                disabled={pending}
                key={option.value}
                onPress={() => onProviderToggle(option.value)}
                selected={providers.includes(option.value)}
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
              <Label htmlFor="onboarding-referral-detail">
                Where was it?
                <span className="font-normal text-muted-foreground">Optional</span>
              </Label>
              <Input
                disabled={pending}
                id="onboarding-referral-detail"
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
