import { CheckIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import {
  SLACK_WORKSPACE_WIZARD_STEPS,
  type SlackWorkspaceWizardStep,
} from "./slackWorkspaceWizard.logic";

export interface SlackWorkspaceWizardStepsProps {
  readonly currentStep: SlackWorkspaceWizardStep;
  readonly completedThrough: number;
  readonly summaries: readonly (string | null)[];
  readonly onStepSelect: (step: SlackWorkspaceWizardStep) => void;
}

export function SlackWorkspaceWizardSteps({
  currentStep,
  completedThrough,
  summaries,
  onStepSelect,
}: SlackWorkspaceWizardStepsProps) {
  return (
    <nav aria-label="Slack workspace setup progress">
      <ol
        className="grid grid-cols-3 gap-1 rounded-xl bg-zinc-25 p-1 ring-1 ring-black/5 dark:bg-white/4 dark:ring-white/5"
        role="list"
      >
        {SLACK_WORKSPACE_WIZARD_STEPS.map((label, index) => {
          const step = index as SlackWorkspaceWizardStep;
          const complete = index <= completedThrough && index !== currentStep;
          return (
            <li className="min-w-0" key={label}>
              <button
                aria-current={currentStep === step ? "step" : undefined}
                aria-label={`${label}, step ${index + 1}${complete && summaries[index] ? `, ${summaries[index]}` : ""}`}
                className={cn(
                  "flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2.5 py-2 text-left outline-none hover:bg-card focus-visible:ring-2 focus-visible:ring-ring max-sm:justify-center max-sm:px-2",
                  currentStep === step &&
                    "bg-card text-foreground shadow-xs ring-1 ring-black/5 hover:bg-card dark:shadow-none dark:ring-white/5",
                )}
                onClick={() => onStepSelect(step)}
                type="button"
              >
                <span
                  aria-hidden
                  className={cn(
                    "grid size-5 shrink-0 place-items-center rounded-full text-sm font-medium ring-1",
                    complete
                      ? "bg-primary text-primary-foreground ring-primary"
                      : currentStep === step
                        ? "bg-primary/10 text-primary ring-primary/30"
                        : "bg-card text-muted-foreground ring-black/10 dark:bg-white/5 dark:ring-white/10",
                  )}
                >
                  {complete ? <CheckIcon className="size-4" /> : index + 1}
                </span>
                <span
                  className={cn(
                    "min-w-0 truncate text-sm font-medium max-sm:hidden",
                    currentStep === step ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {label}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
