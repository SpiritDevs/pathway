/**
 * The toast every captured email raises, from any route.
 *
 * Mounted above the router rather than inside the Email view: the point of the toast is that an
 * agent's verification mail finds you while you are reading a thread. It folds the same
 * `email.stream` the view reads, so being on `/email` costs no second subscription.
 *
 * Every capture toasts, not only the ones with a code — the escape hatch is the per-project mute on
 * each sidebar inbox row and the master switch in Email settings, both of which this respects.
 *
 * @module components/email/EmailCaptureToastHost
 */
import type { CapturedEmailSummary } from "@spiritdevs/contracts";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { CheckIcon, CopyIcon, MailIcon, ZapOffIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { emailStreamViewAtom, useEmailSettings } from "~/state/email";
import { toastManager } from "../ui/toast";
import { emailScopeParam } from "./emailView.logic";
import {
  emailSenderLabel,
  emailSubjectLabel,
  shouldToastCapturedEmail,
} from "./emailSettings.logic";

/**
 * The detected code, big and monospaced, as one click target.
 *
 * The whole chip copies rather than a separate icon button beside it: a 2FA code is read and copied
 * as one gesture, and a toast that times out is the wrong place to make someone aim.
 */
function EmailCaptureCodeChip({ code }: { code: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "verification code" });

  return (
    <button
      aria-label={`Copy verification code ${code}`}
      className="mt-1.5 inline-flex items-center gap-2 rounded-md border border-border/70 bg-muted/50 px-2.5 py-1 font-mono text-lg leading-tight font-semibold tracking-[0.18em] text-foreground tabular-nums transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      onClick={() => copyToClipboard(code, undefined)}
      type="button"
    >
      {code}
      {isCopied ? (
        <CheckIcon aria-hidden="true" className="size-3.5 text-success" />
      ) : (
        <CopyIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
      )}
    </button>
  );
}

function EmailCaptureToastBody({ message }: { message: CapturedEmailSummary }) {
  return (
    <span className="flex min-w-0 flex-col">
      <span className="truncate">{emailSubjectLabel(message)}</span>
      {message.detectedCode === null ? null : <EmailCaptureCodeChip code={message.detectedCode} />}
    </span>
  );
}

export function EmailCaptureToastHost() {
  const navigate = useNavigate();
  const streamState = useAtomValue(emailStreamViewAtom).state;
  const { settings } = useEmailSettings();

  const captured = streamState.lastCaptured;
  const capturedId = captured?.id ?? null;
  // Which message the last toast was about, so a re-render (or an unrelated stream event) does not
  // raise the same one twice.
  const toastedMessageIdRef = useRef<string | null>(null);

  const raiseCaptureToast = useEffectEvent((message: CapturedEmailSummary) => {
    if (!shouldToastCapturedEmail(settings, message)) return;
    toastManager.add({
      type: "info",
      title: `New mail from ${emailSenderLabel(message)}`,
      description: <EmailCaptureToastBody message={message} />,
      actionProps: {
        children: "Open",
        onClick: () => {
          void navigate({
            to: "/email",
            search: {
              inbox: emailScopeParam(
                message.attribution.projectId === null
                  ? { type: "unassigned" }
                  : { type: "project", projectId: message.attribution.projectId },
              ),
              message: message.id,
              environment: undefined,
              tag: undefined,
              tab: undefined,
              analytics: undefined,
            },
          });
        },
      },
      data: {
        hideCopyButton: true,
        leadingIcon: <MailIcon aria-hidden="true" className="size-4 text-info" />,
      },
    });
  });

  useEffect(() => {
    if (captured === null || capturedId === null) return;
    if (toastedMessageIdRef.current === capturedId) return;
    toastedMessageIdRef.current = capturedId;
    raiseCaptureToast(captured);
  }, [captured, capturedId]);

  // Loop detection disables a rule on the server with no client command to report it, so the notice
  // rides the same stream the mail does.
  const autoDisabled = streamState.lastAutoDisabledTrigger;
  const autoDisabledFiringId = autoDisabled?.firing.id ?? null;
  const noticedFiringIdRef = useRef<string | null>(null);
  const raiseAutoDisabledToast = useEffectEvent((notice: string) => {
    toastManager.add({
      type: "warning",
      title: "Mail trigger rule disabled",
      description: notice,
      timeout: 0,
      actionProps: {
        children: "Email settings",
        onClick: () => {
          void navigate({ to: "/settings/email" });
        },
      },
      data: {
        hideCopyButton: true,
        leadingIcon: <ZapOffIcon aria-hidden="true" className="size-4 text-warning" />,
      },
    });
  });

  useEffect(() => {
    if (autoDisabled === null || autoDisabledFiringId === null) return;
    if (noticedFiringIdRef.current === autoDisabledFiringId) return;
    noticedFiringIdRef.current = autoDisabledFiringId;
    raiseAutoDisabledToast(autoDisabled.notice);
  }, [autoDisabled, autoDisabledFiringId]);

  return null;
}
