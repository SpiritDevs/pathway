import {
  PROVIDER_USAGE_OPTIONS,
  REFERRAL_SOURCE_OPTIONS,
  type ProviderUsage,
  type ReferralSource,
} from "@t3tools/client-runtime/profile";

import { AuthCard, AuthChip, AuthChipGroup, AuthField } from "../components/AuthControls";

/**
 * Step 3, individual branch. "Which providers do you use" is setup rather than
 * survey — it is the list of adapters that exist, and can seed first-run
 * provider configuration (docs/internals/decisions/0004).
 */
export function OnboardingIndividualStep(props: {
  readonly providers: ReadonlyArray<ProviderUsage>;
  readonly referralSource: ReferralSource | null;
  readonly referralDetail: string;
  readonly onToggleProvider: (value: ProviderUsage) => void;
  readonly onChangeReferralSource: (value: ReferralSource | null) => void;
  readonly onChangeReferralDetail: (value: string) => void;
}) {
  return (
    <AuthCard>
      <AuthChipGroup label="Which agents do you use today?">
        {PROVIDER_USAGE_OPTIONS.map((option) => (
          <AuthChip
            key={option.value}
            label={option.label}
            onPress={() => props.onToggleProvider(option.value)}
            selected={props.providers.includes(option.value)}
          />
        ))}
      </AuthChipGroup>

      <AuthChipGroup label="How did you hear about us?">
        {REFERRAL_SOURCE_OPTIONS.map((option) => (
          <AuthChip
            key={option.value}
            label={option.label}
            onPress={() =>
              props.onChangeReferralSource(
                props.referralSource === option.value ? null : option.value,
              )
            }
            selected={props.referralSource === option.value}
          />
        ))}
      </AuthChipGroup>

      {props.referralSource === "other" ? (
        <AuthField
          label="Where was that?"
          inputProps={{
            onChangeText: props.onChangeReferralDetail,
            placeholder: "A conference, a newsletter, ...",
            value: props.referralDetail,
          }}
        />
      ) : null}
    </AuthCard>
  );
}
