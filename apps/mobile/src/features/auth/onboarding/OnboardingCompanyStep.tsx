import {
  COMPANY_ROLE_OPTIONS,
  COMPANY_SIZE_OPTIONS,
  type CompanyRole,
  type CompanySize,
} from "@t3tools/client-runtime/profile";

import { AuthCard, AuthChip, AuthChipGroup, AuthField } from "../components/AuthControls";

/**
 * Step 3, company branch. Every field is skippable; tapping a selected chip
 * clears it, so an answer given by accident is not permanent.
 */
export function OnboardingCompanyStep(props: {
  readonly name: string;
  readonly size: CompanySize | null;
  readonly role: CompanyRole | null;
  readonly onChangeName: (value: string) => void;
  readonly onChangeSize: (value: CompanySize | null) => void;
  readonly onChangeRole: (value: CompanyRole | null) => void;
}) {
  return (
    <AuthCard>
      <AuthField
        label="Company"
        inputProps={{
          autoCapitalize: "words",
          autoComplete: "organization",
          onChangeText: props.onChangeName,
          placeholder: "Acme",
          textContentType: "organizationName",
          value: props.name,
        }}
      />

      <AuthChipGroup label="Company size">
        {COMPANY_SIZE_OPTIONS.map((option) => (
          <AuthChip
            key={option.value}
            label={option.label}
            onPress={() => props.onChangeSize(props.size === option.value ? null : option.value)}
            selected={props.size === option.value}
          />
        ))}
      </AuthChipGroup>

      <AuthChipGroup label="Your role">
        {COMPANY_ROLE_OPTIONS.map((option) => (
          <AuthChip
            key={option.value}
            label={option.label}
            onPress={() => props.onChangeRole(props.role === option.value ? null : option.value)}
            selected={props.role === option.value}
          />
        ))}
      </AuthChipGroup>
    </AuthCard>
  );
}
