/**
 * The controls the two capture surfaces share: the mail slug, the capture password, and the copy
 * affordance beside a value an app has to be told about.
 *
 * Settings → Capture and a project's own page edit the same fields of the same document. A slug
 * rename validated one way here and another way there is exactly the drift this exists to prevent,
 * so both render these rather than restating the validation and the copy toast.
 *
 * @module components/email/EmailCaptureFields
 */
import type { EmailMailSlug } from "@t3tools/contracts";
import { CopyIcon } from "lucide-react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { capturePasswordError, mailSlugError, parseCapturePassword } from "./emailSettings.logic";
import { EmailSettingField } from "./EmailSettingsField";

/** Both surfaces describe the slug the same way, because it routes the same way in both. */
export const MAIL_SLUG_DESCRIPTION =
  "Mail routes to this project when the SMTP AUTH username is the slug, when a recipient uses it as a domain, or when a recipient carries it as a plus tag.";

/**
 * Said plainly, in both places: the listener never validates a password, so this is a label that
 * picks an inbox and not a secret that protects one.
 */
export const CAPTURE_PASSWORD_DESCRIPTION =
  "A routing label, not a secret — the listener accepts any credentials and never checks this. Set it for an app that sends from one fixed SMTP account to arbitrary test recipients: whatever it addresses, mail authenticated with this password lands here. Leave it empty to route by username, recipient domain, or plus tag instead.";

/**
 * Copies a capture value and says which one landed.
 *
 * The label doubles as the clipboard target, so a failure names the thing that failed to copy
 * instead of "text".
 */
export function useCaptureValueCopy(label: string): (value: string) => void {
  const { copyToClipboard } = useCopyToClipboard<{ value: string }>({
    target: label.toLowerCase(),
    onCopy: ({ value }) => {
      toastManager.add({ type: "success", title: `${label} copied`, description: value });
    },
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Failed to copy the ${label.toLowerCase()}`,
          description: error.message,
        }),
      );
    },
  });

  return (value: string) => copyToClipboard(value, { value });
}

export function CopyValueButton({
  label,
  value,
  ariaLabel,
  disabled = false,
}: {
  /** Names the value in the toast, e.g. "Capture address". */
  label: string;
  value: string;
  /** Qualified with the project when several of these sit on one page. */
  ariaLabel?: string;
  disabled?: boolean;
}) {
  const copy = useCaptureValueCopy(label);

  return (
    <Button
      aria-label={ariaLabel ?? `Copy ${label.toLowerCase()}`}
      disabled={disabled}
      onClick={() => copy(value)}
      size="icon-sm"
      variant="outline"
    >
      <CopyIcon aria-hidden="true" />
    </Button>
  );
}

/** A value the app being wired up has to be given verbatim, with the copy button beside it. */
export function CopyableCaptureValue({
  label,
  value,
  ariaLabel,
}: {
  label: string;
  value: string;
  /** Required here: these sit several to a page, one set per project. */
  ariaLabel: string;
}) {
  return (
    <div className="flex w-full items-center justify-end gap-2 sm:w-auto">
      <span className="truncate font-mono text-xs text-muted-foreground">{value}</span>
      <CopyValueButton ariaLabel={ariaLabel} label={label} value={value} />
    </div>
  );
}

export function MailSlugField({
  value,
  takenSlugs,
  ariaLabel = "Mail slug",
  onCommit,
}: {
  value: EmailMailSlug;
  /** Every other project's slug; the server owns collisions, this catches them a round trip early. */
  takenSlugs: ReadonlyArray<EmailMailSlug>;
  ariaLabel?: string;
  onCommit: (mailSlug: EmailMailSlug) => Promise<boolean>;
}) {
  return (
    <EmailSettingField
      ariaLabel={ariaLabel}
      onCommit={(draft) => onCommit(draft.trim() as EmailMailSlug)}
      validate={(draft) =>
        mailSlugError(draft) ??
        (takenSlugs.includes(draft.trim() as EmailMailSlug)
          ? "Another project already uses that slug."
          : null)
      }
      value={value}
    />
  );
}

export function CapturePasswordField({
  value,
  takenPasswords,
  ariaLabel = "Capture password",
  onCommit,
}: {
  value: string | null;
  takenPasswords: ReadonlyArray<string>;
  ariaLabel?: string;
  /** Null is the cleared state, which is what an emptied field commits. */
  onCommit: (capturePassword: string | null) => Promise<boolean>;
}) {
  return (
    <EmailSettingField
      ariaLabel={ariaLabel}
      onCommit={(draft) => onCommit(parseCapturePassword(draft))}
      placeholder="No password routing"
      validate={(draft) => capturePasswordError(draft, takenPasswords)}
      value={value ?? ""}
    />
  );
}
