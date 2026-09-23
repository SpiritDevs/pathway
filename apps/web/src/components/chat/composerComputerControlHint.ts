import type {
  ProviderDriverKind,
  ProviderOptionChoice,
  ProviderOptionDescriptor,
  ProviderOptionSelection,
} from "@spiritdevs/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
  isClaudeUltrathinkPrompt,
} from "@spiritdevs/shared/model";

/** Effort rung the hint offers; must exist on the model's ladder to be offered. */
export const COMPUTER_CONTROL_HINT_EFFORT = "medium";

export const COMPUTER_CONTROL_HINT_MESSAGE = "Desktop actions are faster at Medium effort";
export const COMPUTER_CONTROL_HINT_ACTION_LABEL = "Use Medium";

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

/**
 * The effort facts the hint reads. Effort is "still on the default" when the
 * resolved value equals the model's default rung.
 */
export interface ComputerControlEffortHintTraits {
  readonly effort: string | null;
  readonly defaultEffort: string | null;
  readonly effortLevels: ReadonlyArray<ProviderOptionChoice>;
  readonly ultrathinkPromptControlled: boolean;
}

export interface ComputerControlEffortHintInput {
  /** Resolved Computer choice for this send (the setting or a `/computer-use` request). */
  readonly enableComputerControl: boolean;
  /** Server-side desktop control availability; a tip about speed is noise without it. */
  readonly computerControlAvailable: boolean;
  /** `dismissedComputerControlEffortHint`, set by both the apply and dismiss actions. */
  readonly dismissed: boolean;
  readonly provider: ProviderDriverKind | string;
  readonly traits: ComputerControlEffortHintTraits;
}

function primarySelectDescriptor(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): SelectDescriptor | null {
  return (
    descriptors.find(
      (descriptor): descriptor is SelectDescriptor => descriptor.type === "select",
    ) ?? null
  );
}

/** Reads the hint's effort facts from the composer's resolved option descriptors. */
export function getComputerControlEffortHintTraits(input: {
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly prompt: string;
}): ComputerControlEffortHintTraits {
  const descriptor = primarySelectDescriptor(input.descriptors);
  if (!descriptor) {
    return {
      effort: null,
      defaultEffort: null,
      effortLevels: [],
      ultrathinkPromptControlled: false,
    };
  }
  const ultrathinkPromptControlled =
    (descriptor.promptInjectedValues?.length ?? 0) > 0 && isClaudeUltrathinkPrompt(input.prompt);
  const current = getProviderOptionCurrentValue(descriptor);
  return {
    effort: ultrathinkPromptControlled
      ? "ultrathink"
      : typeof current === "string"
        ? current
        : null,
    defaultEffort: descriptor.options.find((option) => option.isDefault)?.id ?? null,
    effortLevels: descriptor.options,
    ultrathinkPromptControlled,
  };
}

/**
 * Shows only for a claudeAgent chat that drives the desktop, on a model whose
 * effort ladder offers Medium, while effort is untouched at its default. Effort
 * for this provider applies per turn, so acting on the hint costs nothing.
 */
export function shouldShowComputerControlEffortHint(
  input: ComputerControlEffortHintInput,
): boolean {
  if (!input.enableComputerControl || !input.computerControlAvailable || input.dismissed) {
    return false;
  }
  if (input.provider !== "claudeAgent") {
    return false;
  }
  const { effort, defaultEffort, effortLevels, ultrathinkPromptControlled } = input.traits;
  // A prompt-driven mode (Ultrathink) owns effort; the picker refuses changes too.
  if (ultrathinkPromptControlled) {
    return false;
  }
  if (!effortLevels.some((level) => level.id === COMPUTER_CONTROL_HINT_EFFORT)) {
    return false;
  }
  // Nothing to suggest when the model already defaults to Medium (or has no default).
  if (defaultEffort === null || defaultEffort === COMPUTER_CONTROL_HINT_EFFORT) {
    return false;
  }
  return effort === defaultEffort;
}

/** The composer's option selections with effort moved to Medium, all else kept. */
export function buildComputerControlHintOptions(
  descriptors: ReadonlyArray<ProviderOptionDescriptor>,
): Array<ProviderOptionSelection> | undefined {
  const effortId = primarySelectDescriptor(descriptors)?.id;
  return buildProviderOptionSelectionsFromDescriptors(
    descriptors.map((descriptor) =>
      descriptor.id === effortId && descriptor.type === "select"
        ? { ...descriptor, currentValue: COMPUTER_CONTROL_HINT_EFFORT }
        : descriptor,
    ),
  );
}
