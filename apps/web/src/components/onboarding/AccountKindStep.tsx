import { type AccountKind } from "@t3tools/client-runtime/profile";
import { Building2Icon, UserIcon, type LucideIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import { Spinner } from "~/components/ui/spinner";
import { StepBody, StepControls, StepHeader } from "./StackedStepCards";
import { ONBOARDING_STEP_DESCRIPTIONS, ONBOARDING_STEP_TITLES } from "./onboardingStepper.logic";

interface AccountKindChoice {
  readonly description: string;
  readonly icon: LucideIcon;
  readonly title: string;
  readonly value: AccountKind;
}

const ACCOUNT_KIND_CHOICES: ReadonlyArray<AccountKindChoice> = [
  {
    description: "Just you and your own machines. Personal projects and side work.",
    icon: UserIcon,
    title: "Individual",
    value: "individual",
  },
  {
    description: "You work with a team. We will ask two things about it next.",
    icon: Building2Icon,
    title: "Company",
    value: "company",
  },
];

/**
 * Step two, and the fork in the flow. Choosing writes `accountKind` before the
 * deck advances, which is what makes a refresh mid-onboarding resume on the
 * right branch.
 */
export function AccountKindStep({
  error,
  onBack,
  onSelect,
  pending,
  pendingKind,
  selected,
}: {
  readonly error: string | null;
  readonly onBack: () => void;
  readonly onSelect: (accountKind: AccountKind) => void;
  readonly pending: boolean;
  /** Which card is mid-write, so only that one shows a spinner. */
  readonly pendingKind: AccountKind | null;
  readonly selected: AccountKind | null;
}) {
  return (
    <>
      <StepBody>
        <StepHeader
          description={ONBOARDING_STEP_DESCRIPTIONS["account-kind"]}
          title={ONBOARDING_STEP_TITLES["account-kind"]}
        />

        <div className="grid gap-3 sm:grid-cols-2">
          {ACCOUNT_KIND_CHOICES.map((choice) => (
            <AccountKindCard
              choice={choice}
              key={choice.value}
              onSelect={onSelect}
              pending={pending}
              selected={selected === choice.value}
              showSpinner={pendingKind === choice.value}
            />
          ))}
        </div>
      </StepBody>

      <StepControls error={error}>
        <Button disabled={pending} onClick={onBack} size="lg" variant="ghost">
          Back
        </Button>
        <p className="text-xs text-muted-foreground">Pick one to continue.</p>
      </StepControls>
    </>
  );
}

function AccountKindCard({
  choice,
  onSelect,
  pending,
  selected,
  showSpinner,
}: {
  readonly choice: AccountKindChoice;
  readonly onSelect: (accountKind: AccountKind) => void;
  readonly pending: boolean;
  readonly selected: boolean;
  readonly showSpinner: boolean;
}) {
  const Icon = choice.icon;

  return (
    <button
      aria-pressed={selected}
      className={cn(
        "flex cursor-pointer flex-col items-start gap-3 rounded-xl border border-border bg-background p-5 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64",
        selected ? "ring-2 ring-primary" : "hover:bg-accent/50",
      )}
      disabled={pending}
      onClick={() => onSelect(choice.value)}
      type="button"
    >
      <span className="flex size-10 items-center justify-center rounded-lg border border-border bg-card">
        {showSpinner ? (
          <Spinner className="size-5 text-muted-foreground" />
        ) : (
          <Icon aria-hidden className="size-5 text-muted-foreground" />
        )}
      </span>
      <span className="text-base font-semibold text-foreground">{choice.title}</span>
      <span className="text-sm leading-relaxed text-muted-foreground">{choice.description}</span>
    </button>
  );
}
