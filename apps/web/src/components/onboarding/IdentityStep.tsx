import { UserRoundIcon } from "lucide-react";
import { useRef, type ChangeEvent } from "react";

import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Label } from "~/components/ui/label";
import { Spinner } from "~/components/ui/spinner";
import { StepBody, StepControls, StepHeader } from "./StackedStepCards";
import {
  ONBOARDING_STEP_DESCRIPTIONS,
  ONBOARDING_STEP_TITLES,
  canContinueFromIdentity,
} from "./onboardingStepper.logic";

const AVATAR_INPUT_ID = "onboarding-avatar-file";

/**
 * Step one. The first name is the single required field in the whole flow; the
 * avatar is opt-in and stays skippable in one click.
 */
export function IdentityStep({
  avatarPreviewUrl,
  error,
  firstName,
  lastName,
  onAvatarFileSelected,
  onAvatarRemoved,
  onContinue,
  onFirstNameChange,
  onLastNameChange,
  pending,
}: {
  /** Local object URL for a staged file, else the hosted Clerk image, else null. */
  readonly avatarPreviewUrl: string | null;
  readonly error: string | null;
  readonly firstName: string;
  readonly lastName: string;
  readonly onAvatarFileSelected: (file: File) => void;
  readonly onAvatarRemoved: () => void;
  readonly onContinue: () => void;
  readonly onFirstNameChange: (value: string) => void;
  readonly onLastNameChange: (value: string) => void;
  readonly pending: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Clearing the input lets the same file be re-picked after a removal.
    event.target.value = "";
    if (!file) return;
    onAvatarFileSelected(file);
  }

  return (
    <>
      <StepBody>
        <StepHeader
          description={ONBOARDING_STEP_DESCRIPTIONS.identity}
          title={ONBOARDING_STEP_TITLES.identity}
        />

        <div className="flex items-center gap-4">
          <span className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border bg-background">
            {avatarPreviewUrl === null ? (
              <UserRoundIcon aria-hidden className="size-7 text-muted-foreground" />
            ) : (
              <img
                alt="Your profile photo"
                className="size-full object-cover"
                src={avatarPreviewUrl}
              />
            )}
          </span>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              {/* A real button rather than a styled <label>: labels are not
                  keyboard-focusable, and this control has to be reachable by
                  tab like every other control on the card. */}
              <Button
                disabled={pending}
                onClick={() => fileInputRef.current?.click()}
                size="sm"
                variant="outline"
              >
                {avatarPreviewUrl === null ? "Add a photo" : "Change photo"}
              </Button>
              {avatarPreviewUrl === null ? null : (
                <Button disabled={pending} onClick={onAvatarRemoved} size="sm" variant="ghost">
                  Remove
                </Button>
              )}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">
              Optional. You can add or change this any time.
            </p>
          </div>

          <input
            accept="image/*"
            aria-label="Profile photo"
            className="sr-only"
            disabled={pending}
            id={AVATAR_INPUT_ID}
            onChange={handleFileChange}
            ref={fileInputRef}
            tabIndex={-1}
            type="file"
          />
        </div>

        <div className="mt-7 grid gap-4 sm:grid-cols-2">
          <div className="grid gap-2">
            <Label htmlFor="onboarding-first-name">First name</Label>
            <Input
              autoComplete="given-name"
              disabled={pending}
              id="onboarding-first-name"
              onValueChange={onFirstNameChange}
              placeholder="Ada"
              required
              value={firstName}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="onboarding-last-name">
              Last name
              <span className="font-normal text-muted-foreground">Optional</span>
            </Label>
            <Input
              autoComplete="family-name"
              disabled={pending}
              id="onboarding-last-name"
              onValueChange={onLastNameChange}
              placeholder="Lovelace"
              value={lastName}
            />
          </div>
        </div>
      </StepBody>

      <StepControls error={error}>
        <p className="text-xs text-muted-foreground">Your first name is all we need.</p>
        <Button
          disabled={pending || !canContinueFromIdentity(firstName)}
          onClick={onContinue}
          size="lg"
        >
          {pending ? <Spinner className="size-4" /> : null}
          Continue
        </Button>
      </StepControls>
    </>
  );
}
