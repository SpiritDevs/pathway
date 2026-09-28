import type { EnvironmentId } from "@spiritdevs/contracts";
import type { AppleIdSessionState as AppleIdSessionSchema } from "@spiritdevs/contracts/apple";
import type { CompanyId } from "@spiritdevs/contracts/company";
import type { XcodeJob, XcodePlatform, XcodeStatus, XcodeStep } from "@spiritdevs/contracts/xcode";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@spiritdevs/client-runtime/state/runtime";
import {
  canCancelXcodeJob,
  canRetryXcodeJob,
  describeXcodeDownload,
  diskShortfall,
  formatXcodeBytes,
  isXcodeJobActive,
  missingXcodePlatforms,
  nextXcodeAdminApproval,
  orderAvailableXcodes,
  summarizeXcodeJob,
  usableXcode,
  XCODE_JOB_STATE_LABELS,
  XCODE_PLATFORMS,
  XCODE_STEP_STATE_LABELS,
  xcodeAdminStepKey,
  xcodeJobAnnouncement,
  xcodeInstallRequiredBytes,
  xcodeJobTitle,
  xcodeRuntimesRequiredBytes,
  type XcodeView,
} from "@spiritdevs/client-runtime/state/xcodeSetup";
import { Link } from "@tanstack/react-router";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleXIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  appleAccountFunctions,
  useAppleAccountsClient,
  useAppleCloudQuery,
  type AppleAccount,
} from "~/cloud/appleAccounts";
import { cn } from "~/lib/utils";
import { appleEnvironment } from "~/state/apple";
import { useEnvironment } from "~/state/environments";
import { useEnvironmentQuery, type EnvironmentQueryView } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { xcodeEnvironment } from "~/state/xcode";
import { appleRpcCompanyId } from "../settings/AppleAccountsSettings.logic";
import { useCompanySettings } from "../settings/company/useCompanySettings";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Progress } from "../ui/progress";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  appleIdPasswordFormKey,
  appleIdSignInStage,
  describeMac,
  describeXcodeFailure,
  pickXcodeAccountId,
  readRememberedXcodeAccount,
  rememberXcodeAccount,
  xcodeHostSupport,
} from "./XcodeSetup.logic";

export interface XcodeTarget {
  readonly companyId: CompanyId;
  readonly accountId: string;
}

type AppleIdSessionState = typeof AppleIdSessionSchema.Type;
export type AppleIdSessionView = EnvironmentQueryView<AppleIdSessionState>;

/** Runs one environment command, keeping its pending flag and safe error message. */
function useXcodeAction() {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async <A, E>(
    key: string,
    fallback: string,
    action: () => Promise<AtomCommandResult<A, E>>,
  ): Promise<AtomCommandResult<A, E> | null> => {
    if (pending !== null) return null;
    setPending(key);
    setError(null);
    try {
      const result = await action();
      if (result._tag === "Failure") {
        setError(describeXcodeFailure(squashAtomCommandFailure(result), fallback));
      }
      return result;
    } finally {
      setPending(null);
    }
  };
  return { pending, error, run, clearError: () => setError(null) };
}

function ActionError({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-xs text-destructive">
      {message}
    </p>
  ) : null;
}

/** The environment's Mac as the user knows it, plus whether it can run Xcode at all. */
export function useXcodeHost(environmentId: EnvironmentId | null) {
  const environment = useEnvironment(environmentId);
  const descriptor = environment?.descriptor ?? null;
  return {
    label: environment?.label ?? "this environment",
    mac: describeMac(descriptor),
    support: xcodeHostSupport(descriptor),
    connected: environment?.connection.phase === "connected",
  };
}

/** Apple IDs visible in the current workspace, and which one authorizes this Mac's Xcode work. */
export function useXcodeAccount(environmentId: EnvironmentId | null) {
  const settings = useCompanySettings();
  const client = useAppleAccountsClient();
  const tetherCompanyId =
    settings.activeCompany?.workspaceKind === "organization" ? settings.companyId : null;
  const accounts = useAppleCloudQuery(
    client,
    appleAccountFunctions.listAccounts,
    tetherCompanyId ? { companyId: tetherCompanyId } : {},
  );
  const contentCompanyId = (settings.contentCompanyId ??
    settings.personalCompany?.id ??
    null) as CompanyId | null;
  const [chosenId, setChosenId] = useState<string | null>(() =>
    environmentId === null ? null : readRememberedXcodeAccount(environmentId),
  );
  const list = accounts.data ?? [];
  const accountId = pickXcodeAccountId(list, chosenId);
  const account = list.find((candidate) => candidate.id === accountId) ?? null;
  const companyId = account ? appleRpcCompanyId(account.scope, contentCompanyId) : null;
  const target = useMemo<XcodeTarget | null>(
    () => (account && companyId ? { companyId, accountId: account.id } : null),
    [account, companyId],
  );
  return {
    accounts: list,
    loading: accounts.data === undefined && !accounts.error,
    error: accounts.error ? "Could not load Apple accounts." : null,
    account,
    target,
    choose: (id: string) => {
      setChosenId(id);
      if (environmentId !== null) rememberXcodeAccount(environmentId, id);
    },
  };
}

export type XcodeAccountSelection = ReturnType<typeof useXcodeAccount>;

/** Live Apple ID session and Xcode inventory; both streams close when the caller unmounts. */
export function useXcodeLive(
  environmentId: EnvironmentId | null,
  target: XcodeTarget | null,
  active: boolean,
) {
  const enabled = active && environmentId !== null && target !== null;
  const session = useEnvironmentQuery(
    enabled ? appleEnvironment.idSession({ environmentId, input: target }) : null,
  );
  const view = useEnvironmentQuery(
    enabled ? xcodeEnvironment.view({ environmentId, input: target }) : null,
  );
  return { session, view };
}

export function XcodeAccountPicker({ selection }: { selection: XcodeAccountSelection }) {
  if (selection.error) {
    return (
      <p role="alert" className="text-xs text-destructive">
        {selection.error}
      </p>
    );
  }
  if (selection.loading) {
    return <p className="text-xs text-muted-foreground">Loading Apple accounts…</p>;
  }
  if (selection.accounts.length === 0) {
    return (
      <div className="space-y-2 text-sm">
        <p className="text-muted-foreground">
          Add your Apple ID first. Pathway uses it to download Xcode from Apple.
        </p>
        <Button size="sm" variant="outline" render={<Link to="/settings/apple" />}>
          Add an Apple ID in Settings
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span className="text-muted-foreground">Apple ID</span>
      <Select
        value={selection.account?.id ?? null}
        onValueChange={(value) => {
          if (value !== null) selection.choose(value);
        }}
      >
        <SelectTrigger size="sm" aria-label="Apple ID for Xcode" className="w-auto">
          <SelectValue>{selection.account ? accountLabel(selection.account) : null}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {selection.accounts.map((account) => (
            <SelectItem key={account.id} value={account.id}>
              {accountLabel(account)}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

function accountLabel(account: AppleAccount): string {
  return account.displayName === account.email
    ? account.email
    : `${account.displayName} (${account.email})`;
}

/** Rerenders once at `deadline`, so a stale challenge stops accepting codes without a ticking clock. */
function useExpired(deadline: number | null): boolean {
  const [expired, setExpired] = useState(() => deadline !== null && deadline <= Date.now());
  useEffect(() => {
    if (deadline === null) {
      setExpired(false);
      return;
    }
    const remaining = deadline - Date.now();
    setExpired(remaining <= 0);
    if (remaining <= 0) return;
    const timer = window.setTimeout(() => setExpired(true), remaining + 50);
    return () => window.clearTimeout(timer);
  }, [deadline]);
  return expired;
}

function formatClockTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/**
 * Signs the environment in to an Apple ID: password, then Apple's two-factor code. The password
 * goes to the environment for this attempt only; every watching client sees the same challenge.
 * `signInAgain` asks for a password even though the session reads as signed in, for a session Apple
 * has already rejected.
 */
export function AppleIdSignIn({
  environmentId,
  target,
  email,
  session,
  hostName,
  signInAgain = false,
  onCancelSignInAgain,
}: {
  environmentId: EnvironmentId;
  target: XcodeTarget;
  email: string;
  session: AppleIdSessionView;
  hostName: string;
  signInAgain?: boolean;
  onCancelSignInAgain?: () => void;
}) {
  const stage = appleIdSignInStage(session, signInAgain);
  const data = session.data;
  if (stage === "unavailable") {
    return (
      <div className="space-y-2 text-sm">
        <p role="alert" className="text-destructive">
          Could not read the Apple ID session on {hostName}. {session.error}
        </p>
        <Button size="sm" variant="outline" onClick={session.refresh}>
          Try again
        </Button>
      </div>
    );
  }
  if (data === null) {
    return <p className="text-sm text-muted-foreground">Checking Apple ID…</p>;
  }
  if (stage === "authenticated") {
    return (
      <p className="flex items-center gap-1.5 text-sm">
        <ShieldCheckIcon className="size-4 text-success" aria-hidden />
        Signed in as {email}
      </p>
    );
  }
  if (data.state === "authenticating") {
    return (
      <AppleIdAuthenticating environmentId={environmentId} target={target} flowId={data.flowId} />
    );
  }
  if (data.state === "challenge") {
    return (
      <AppleIdChallenge
        key={data.flowId}
        environmentId={environmentId}
        target={target}
        challenge={data}
      />
    );
  }
  const notice =
    data.state === "expired"
      ? "Your Apple ID session expired. Sign in again to continue."
      : data.state === "failed"
        ? describeXcodeFailure({ _tag: "AppleError", ...data.error }, "Apple sign-in failed.")
        : null;
  return (
    <AppleIdPasswordForm
      // A password typed for one Apple ID must never be submitted for another.
      key={appleIdPasswordFormKey(environmentId, target)}
      environmentId={environmentId}
      target={target}
      email={email}
      hostName={hostName}
      notice={notice}
      onCancel={signInAgain ? onCancelSignInAgain : undefined}
    />
  );
}

/** Cancel stays usable while `apple.id.start` is still waiting on Apple. */
function AppleIdAuthenticating({
  environmentId,
  target,
  flowId,
}: {
  environmentId: EnvironmentId;
  target: XcodeTarget;
  flowId: string;
}) {
  const cancel = useAtomCommand(appleEnvironment.idCancel, { reportFailure: false });
  const action = useXcodeAction();
  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      <span className="text-muted-foreground">Signing in to Apple…</span>
      <Button
        size="sm"
        variant="ghost"
        disabled={action.pending !== null}
        onClick={() =>
          void action.run("cancel", "Could not cancel sign-in.", () =>
            cancel({ environmentId, input: { ...target, flowId } }),
          )
        }
      >
        {action.pending === "cancel" ? "Cancelling…" : "Cancel"}
      </Button>
      <ActionError message={action.error} />
    </div>
  );
}

/** Mounted only while a password is wanted, so leaving this stage discards anything typed. */
function AppleIdPasswordForm({
  environmentId,
  target,
  email,
  hostName,
  notice,
  onCancel,
}: {
  environmentId: EnvironmentId;
  target: XcodeTarget;
  email: string;
  hostName: string;
  notice: string | null;
  onCancel: (() => void) | undefined;
}) {
  const start = useAtomCommand(appleEnvironment.idStart, { reportFailure: false });
  const action = useXcodeAction();
  const [password, setPassword] = useState("");
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        const submitted = password;
        setPassword("");
        void action.run("start", "Apple sign-in failed.", () =>
          start({ environmentId, input: { ...target, password: submitted } }),
        );
      }}
    >
      {notice ? (
        <p role="alert" className="text-sm text-destructive">
          {notice}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        Sign in to {email} so {hostName} can download Xcode from Apple. Your password is used for
        this sign-in only and is never stored.
      </p>
      {/* Lets password managers pair the password with the Apple ID. */}
      <input type="email" autoComplete="username" value={email} readOnly hidden />
      <label className="block max-w-sm space-y-1 text-xs">
        Apple ID password
        <Input
          type="password"
          autoComplete="current-password"
          required
          disabled={action.pending !== null}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <ActionError message={action.error} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={action.pending !== null || !password}>
          {action.pending === "start" ? "Signing in…" : "Sign in"}
        </Button>
        {onCancel ? (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
    </form>
  );
}

function AppleIdChallenge({
  environmentId,
  target,
  challenge,
}: {
  environmentId: EnvironmentId;
  target: XcodeTarget;
  challenge: Extract<AppleIdSessionState, { state: "challenge" }>;
}) {
  const complete = useAtomCommand(appleEnvironment.idComplete, { reportFailure: false });
  const requestCode = useAtomCommand(appleEnvironment.idRequestCode, { reportFailure: false });
  const cancel = useAtomCommand(appleEnvironment.idCancel, { reportFailure: false });
  const action = useXcodeAction();
  const [code, setCode] = useState("");
  const [phoneId, setPhoneId] = useState<number | null>(
    () =>
      challenge.phoneNumbers.find((phone) => phone.destination === challenge.destination)?.id ??
      challenge.phoneNumbers[0]?.id ??
      null,
  );
  const expired = useExpired(challenge.expiresAt);
  const flow = { ...target, flowId: challenge.flowId };
  const sendCode = () => {
    if (phoneId === null) return;
    void action.run("send", "Could not send a code.", () =>
      requestCode({ environmentId, input: { ...flow, phoneNumberId: phoneId } }),
    );
  };
  const cancelButton = (
    <Button
      type="button"
      size="sm"
      variant="ghost"
      disabled={action.pending !== null}
      onClick={() =>
        void action.run("cancel", "Could not cancel sign-in.", () =>
          cancel({ environmentId, input: flow }),
        )
      }
    >
      {expired ? "Start again" : "Cancel"}
    </Button>
  );

  if (expired) {
    return (
      <div className="space-y-2 text-sm">
        <p role="alert" className="text-destructive">
          The verification code request expired. Start again to get a new code.
        </p>
        {cancelButton}
        <ActionError message={action.error} />
      </div>
    );
  }

  const phonePicker =
    challenge.phoneNumbers.length > 0 ? (
      <Select
        value={phoneId === null ? null : String(phoneId)}
        onValueChange={(value) => {
          if (value !== null) setPhoneId(Number(value));
        }}
      >
        <SelectTrigger size="sm" aria-label="Phone number for the code" className="w-auto">
          <SelectValue>
            {challenge.phoneNumbers.find((phone) => phone.id === phoneId)?.destination}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {challenge.phoneNumbers.map((phone) => (
            <SelectItem key={phone.id} value={String(phone.id)}>
              {phone.destination}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    ) : null;

  if (challenge.kind === "sms-choice") {
    return (
      <div className="space-y-3 text-sm">
        <p className="text-muted-foreground">Choose where Apple should text a verification code.</p>
        <div className="flex flex-wrap items-center gap-2">
          {phonePicker}
          <Button
            size="sm"
            disabled={action.pending !== null || phoneId === null}
            onClick={sendCode}
          >
            {action.pending === "send" ? "Sending…" : "Text me a code"}
          </Button>
          {cancelButton}
        </div>
        <ActionError message={action.error} />
      </div>
    );
  }

  return (
    <form
      className="space-y-3 text-sm"
      onSubmit={(event) => {
        event.preventDefault();
        const submitted = code.trim();
        void action
          .run("complete", "That code did not work. Check it and try again.", () =>
            complete({ environmentId, input: { ...flow, code: submitted } }),
          )
          .then((result) => {
            if (result?._tag === "Success") setCode("");
          });
      }}
    >
      <p className="text-muted-foreground">
        {challenge.kind === "trusted-device"
          ? "Enter the verification code shown on your other Apple devices."
          : `Enter the verification code Apple texted to ${challenge.destination ?? "your phone"}.`}{" "}
        The request expires at {formatClockTime(challenge.expiresAt)}.
      </p>
      <label className="block max-w-[12rem] space-y-1 text-xs">
        Verification code
        <Input
          autoFocus
          required
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={8}
          disabled={action.pending !== null}
          value={code}
          onChange={(event) => setCode(event.target.value.replace(/\s/gu, ""))}
        />
      </label>
      <ActionError message={action.error} />
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={action.pending !== null || !code.trim()}>
          {action.pending === "complete" ? "Verifying…" : "Verify"}
        </Button>
        {cancelButton}
      </div>
      {phonePicker ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{challenge.kind === "sms" ? "Didn't get it? Resend to" : "Or text a code to"}</span>
          {phonePicker}
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={action.pending !== null || phoneId === null}
            onClick={sendCode}
          >
            {action.pending === "send" ? "Sending…" : "Send code"}
          </Button>
        </div>
      ) : null}
    </form>
  );
}

const STEP_ICONS: Readonly<Record<XcodeStep["state"], ReactNode>> = {
  pending: <CircleDashedIcon className="size-4 text-muted-foreground" aria-hidden />,
  running: <CircleDotIcon className="size-4 text-primary" aria-hidden />,
  "needs-admin": <CircleAlertIcon className="size-4 text-warning" aria-hidden />,
  completed: <CircleCheckIcon className="size-4 text-success" aria-hidden />,
  skipped: <CircleDashedIcon className="size-4 text-muted-foreground" aria-hidden />,
  failed: <CircleXIcon className="size-4 text-destructive" aria-hidden />,
  cancelled: <CircleXIcon className="size-4 text-muted-foreground" aria-hidden />,
};

const JOB_STATE_BADGE: Readonly<
  Record<XcodeJob["state"], "outline" | "success" | "warning" | "error">
> = {
  running: "outline",
  "needs-admin": "warning",
  "needs-reauth": "warning",
  interrupted: "warning",
  failed: "error",
  cancelling: "outline",
  cancelled: "outline",
  completed: "success",
};

/**
 * One host job with its step list. Progress renders straight from the coalesced snapshots, so a
 * download repaints at most a few times a second.
 */
export function XcodeJobCard({
  environmentId,
  target,
  job,
  status,
  session,
  email,
  hostName,
}: {
  environmentId: EnvironmentId;
  target: XcodeTarget;
  job: XcodeJob;
  status: XcodeStatus | null;
  session: AppleIdSessionView;
  email: string;
  hostName: string;
}) {
  const cancel = useAtomCommand(xcodeEnvironment.cancel, { reportFailure: false });
  const retry = useAtomCommand(xcodeEnvironment.retry, { reportFailure: false });
  const approve = useAtomCommand(xcodeEnvironment.approve, { reportFailure: false });
  const action = useXcodeAction();
  const summary = summarizeXcodeJob(job);
  const input = { ...target, jobId: job.id };
  // The host stays in needs-admin while its prompt is open; remember which step was approved,
  // and forget it once that attempt ends so a retried step can be approved again.
  const [approvedStep, setApprovedStep] = useState<string | null>(null);
  const keptApproval = nextXcodeAdminApproval(approvedStep, job);
  if (keptApproval !== approvedStep) setApprovedStep(keptApproval);
  const adminKey = xcodeAdminStepKey(job);
  const awaitingPrompt = adminKey !== null && keptApproval === adminKey;
  const failure = summary.current?.error?.message ?? null;
  // Apple can reject a session before it expires. Signing in again replaces the session that read
  // as signed in when the user asked; a fresh session has a new expiry and ends this mode.
  const [replacingSession, setReplacingSession] = useState<number | null>(null);
  const sessionData = session.data;
  const signInAgain =
    sessionData?.state === "authenticated" && replacingSession === sessionData.expiresAt;
  const signedIn = sessionData?.state === "authenticated" && !signInAgain && !session.error;

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">{xcodeJobTitle(job, status)}</p>
        <Badge variant={JOB_STATE_BADGE[job.state]} size="sm">
          {XCODE_JOB_STATE_LABELS[job.state]}
        </Badge>
      </div>
      {job.state !== "completed" ? (
        <Progress value={summary.fraction} aria-label="Overall progress" />
      ) : null}
      <ol className="space-y-1.5" aria-label="Steps">
        {summary.steps.map((step) => (
          <li
            key={step.id}
            className="flex items-start gap-2 text-xs"
            aria-current={step.id === summary.current?.id ? "step" : undefined}
          >
            <span className="mt-px">{STEP_ICONS[step.state]}</span>
            <div className="min-w-0 flex-1 space-y-1">
              <p className={cn(step.state === "pending" && "text-muted-foreground")}>
                {step.label}
                <span className="sr-only">: {XCODE_STEP_STATE_LABELS[step.state]}</span>
              </p>
              {step.id === "download" && step.state === "running" && step.progress ? (
                <DownloadProgress progress={step.progress} />
              ) : null}
              {step.error && step.state !== "completed" ? (
                <p className="text-destructive">{step.error.message}</p>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      {job.state === "needs-admin" && adminKey ? (
        <div className="space-y-2 rounded-md border border-warning/40 bg-warning/5 p-3 text-sm">
          <p className="font-medium">Needs admin approval on the Mac</p>
          <p className="text-xs text-muted-foreground">
            {awaitingPrompt
              ? `A macOS password prompt is open on ${hostName}. Someone at that Mac enters an administrator password to continue.`
              : `Approving opens a macOS password prompt on ${hostName}, not on this device. Someone at that Mac enters an administrator password; Pathway never sees it.`}
          </p>
          <Button
            size="sm"
            disabled={awaitingPrompt || action.pending !== null}
            onClick={() =>
              void action
                .run("approve", "Could not ask the Mac for approval.", () =>
                  approve({ environmentId, input }),
                )
                .then((result) => {
                  if (result?._tag === "Success") setApprovedStep(adminKey);
                })
            }
          >
            {awaitingPrompt ? "Waiting for the Mac…" : "Approve on the Mac"}
          </Button>
        </div>
      ) : null}

      {job.state === "needs-reauth" ? (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-sm font-medium">Sign in to your Apple ID again to continue</p>
          <AppleIdSignIn
            environmentId={environmentId}
            target={target}
            email={email}
            session={session}
            hostName={hostName}
            signInAgain={signInAgain}
            onCancelSignInAgain={() => setReplacingSession(null)}
          />
          {signedIn && sessionData?.state === "authenticated" ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-muted-foreground">
                If Apple keeps asking, the saved session no longer works. Sign in again for a fresh
                one.
              </p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => setReplacingSession(sessionData.expiresAt)}
              >
                Sign in again
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}

      {(job.state === "failed" || job.state === "interrupted") && failure ? (
        <p role="alert" className="text-xs text-destructive">
          {failure}
        </p>
      ) : null}
      {job.state === "interrupted" && !failure ? (
        <p className="text-xs text-muted-foreground">
          The environment restarted during this job. Retry to continue where it stopped.
        </p>
      ) : null}
      <ActionError message={action.error} />

      <div className="flex flex-wrap gap-2">
        {canRetryXcodeJob(job) ? (
          <Button
            size="sm"
            disabled={action.pending !== null || (job.state === "needs-reauth" && !signedIn)}
            onClick={() => {
              setApprovedStep(null);
              void action.run("retry", "Could not retry.", () => retry({ environmentId, input }));
            }}
          >
            {action.pending === "retry"
              ? "Retrying…"
              : job.state === "cancelled"
                ? "Resume"
                : "Retry"}
          </Button>
        ) : null}
        {canCancelXcodeJob(job) ? (
          <Button
            size="sm"
            variant="outline"
            disabled={action.pending !== null}
            onClick={() =>
              void action.run("cancel", "Could not cancel.", () => cancel({ environmentId, input }))
            }
          >
            {action.pending === "cancel" ? "Cancelling…" : "Cancel"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function DownloadProgress({ progress }: { progress: NonNullable<XcodeStep["progress"]> }) {
  const download = describeXcodeDownload(progress);
  return (
    <div className="space-y-1 text-muted-foreground">
      {download.fraction !== null ? (
        <Progress value={download.fraction} aria-label="Download progress" className="h-1" />
      ) : null}
      <p className="tabular-nums">
        {[download.amount, download.speed, download.eta].filter(Boolean).join(" · ")}
      </p>
    </div>
  );
}

function PlatformChoices({
  platforms,
  onChange,
  disabled,
  available = XCODE_PLATFORMS,
}: {
  platforms: ReadonlyArray<XcodePlatform>;
  onChange: (next: ReadonlyArray<XcodePlatform>) => void;
  disabled: boolean;
  available?: ReadonlyArray<XcodePlatform>;
}) {
  return (
    <fieldset className="flex flex-wrap gap-4 text-xs" disabled={disabled}>
      <legend className="sr-only">Platforms</legend>
      {available.map((platform) => (
        <label key={platform} className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={platforms.includes(platform)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? XCODE_PLATFORMS.filter(
                      (candidate) => candidate === platform || platforms.includes(candidate),
                    )
                  : platforms.filter((candidate) => candidate !== platform),
              )
            }
          />
          {platform}
        </label>
      ))}
    </fieldset>
  );
}

function DiskLine({ required, free }: { required: number; free: number | null }) {
  const short = diskShortfall(required, free);
  return (
    <p className={cn("text-xs", short === null ? "text-muted-foreground" : "text-destructive")}>
      Needs {formatXcodeBytes(required)}
      {free === null ? "" : ` · ${formatXcodeBytes(free)} free on the Mac`}
      {short === null ? "" : `. Free up ${formatXcodeBytes(short)} to continue.`}
    </p>
  );
}

/** Version and platform choice. The newest release is preselected and marked recommended. */
export function XcodeInstallChooser({
  environmentId,
  target,
  status,
}: {
  environmentId: EnvironmentId;
  target: XcodeTarget;
  status: XcodeStatus;
}) {
  const install = useAtomCommand(xcodeEnvironment.install, { reportFailure: false });
  const action = useXcodeAction();
  const { recommended, ordered } = useMemo(
    () => orderAvailableXcodes(status.available),
    [status.available],
  );
  const [versionId, setVersionId] = useState<string | null>(null);
  const [platforms, setPlatforms] = useState<ReadonlyArray<XcodePlatform>>(["iOS"]);
  const chosen =
    ordered.find((xcode) => xcode.id === versionId) ?? recommended ?? ordered[0] ?? null;
  const installedBuilds = new Set(status.installed.map((xcode) => xcode.build));

  if (ordered.length === 0) {
    return (
      <p className={cn("text-sm", status.error ? "text-destructive" : "text-muted-foreground")}>
        {status.error?.message ?? "No Xcode releases are available for this Mac right now."}
      </p>
    );
  }
  const required = chosen ? xcodeInstallRequiredBytes(chosen, platforms) : 0;
  const blocked = chosen === null || diskShortfall(required, status.disk.freeBytes) !== null;
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!chosen) return;
        void action.run("install", "Could not start the install.", () =>
          install({ environmentId, input: { ...target, versionId: chosen.id, platforms } }),
        );
      }}
    >
      <fieldset className="space-y-1" disabled={action.pending !== null}>
        <legend className="mb-1 text-xs font-medium">Xcode version</legend>
        <ul className="max-h-64 space-y-1 overflow-y-auto">
          {ordered.map((xcode) => (
            <li key={xcode.id}>
              <label
                className={cn(
                  "flex items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-accent/50",
                  xcode.id === chosen?.id ? "border-primary/40 bg-accent/50" : "border-transparent",
                )}
              >
                <input
                  type="radio"
                  name="xcode-version"
                  checked={xcode.id === chosen?.id}
                  onChange={() => setVersionId(xcode.id)}
                />
                <span className="font-medium">Xcode {xcode.version}</span>
                <span className="font-mono text-xs text-muted-foreground">{xcode.build}</span>
                {xcode.id === recommended?.id ? (
                  <Badge variant="success" size="sm">
                    Recommended
                  </Badge>
                ) : null}
                {xcode.beta ? (
                  <Badge variant="outline" size="sm">
                    Beta
                  </Badge>
                ) : null}
                {installedBuilds.has(xcode.build) ? (
                  <Badge variant="outline" size="sm">
                    Installed
                  </Badge>
                ) : null}
                {xcode.downloadBytes !== null ? (
                  <span className="ml-auto text-xs text-muted-foreground">
                    {formatXcodeBytes(xcode.downloadBytes)} download
                  </span>
                ) : null}
              </label>
            </li>
          ))}
        </ul>
      </fieldset>
      <div className="space-y-1">
        <p className="text-xs font-medium">Platforms</p>
        <PlatformChoices
          platforms={platforms}
          onChange={setPlatforms}
          disabled={action.pending !== null}
        />
        <p className="text-xs text-muted-foreground">
          macOS is always included. Add platforms now or later from Settings.
        </p>
      </div>
      <DiskLine required={required} free={status.disk.freeBytes} />
      <ActionError message={action.error} />
      <Button type="submit" size="sm" disabled={blocked || action.pending !== null}>
        {action.pending === "install" ? "Starting…" : `Install Xcode ${chosen?.version ?? ""}`}
      </Button>
    </form>
  );
}

/** Installed Xcodes with the selected one marked; selecting another switches `xcode-select`. */
export function XcodeInstalledList({
  environmentId,
  target,
  status,
  busy,
}: {
  environmentId: EnvironmentId;
  target: XcodeTarget;
  status: XcodeStatus;
  busy: boolean;
}) {
  const select = useAtomCommand(xcodeEnvironment.select, { reportFailure: false });
  const action = useXcodeAction();
  if (status.installed.length === 0) {
    return <p className="text-sm text-muted-foreground">No Xcode is installed on this Mac.</p>;
  }
  return (
    <div className="space-y-2">
      <ul className="space-y-1" aria-label="Installed Xcodes">
        {status.installed.map((xcode) => (
          <li key={xcode.path} className="flex items-center gap-2 rounded-md border px-3 py-2">
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-2 text-sm font-medium">
                Xcode {xcode.version}
                <span className="font-mono text-xs font-normal text-muted-foreground">
                  {xcode.build}
                </span>
                {xcode.beta ? (
                  <Badge variant="outline" size="sm">
                    Beta
                  </Badge>
                ) : null}
              </p>
              <p className="truncate font-mono text-xs text-muted-foreground">{xcode.path}</p>
            </div>
            {xcode.selected ? (
              <Badge variant="success" size="sm">
                Selected
              </Badge>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || action.pending !== null}
                onClick={() =>
                  void action.run(xcode.path, "Could not select this Xcode.", () =>
                    select({ environmentId, input: { ...target, path: xcode.path } }),
                  )
                }
              >
                {action.pending === xcode.path ? "Selecting…" : "Select"}
              </Button>
            )}
          </li>
        ))}
      </ul>
      <ActionError message={action.error} />
    </div>
  );
}

/** Simulator runtimes and the form that adds platforms to the selected Xcode. */
export function XcodeRuntimes({
  environmentId,
  target,
  status,
  busy,
}: {
  environmentId: EnvironmentId;
  target: XcodeTarget;
  status: XcodeStatus;
  busy: boolean;
}) {
  const installRuntimes = useAtomCommand(xcodeEnvironment.installRuntimes, {
    reportFailure: false,
  });
  const action = useXcodeAction();
  const selected = usableXcode(status);
  const missing = missingXcodePlatforms(status);
  const [platforms, setPlatforms] = useState<ReadonlyArray<XcodePlatform>>([]);
  const chosen = platforms.filter((platform) => missing.includes(platform));
  const required = xcodeRuntimesRequiredBytes(chosen);
  const installed = status.runtimes.filter((runtime) => runtime.installed);
  return (
    <div className="space-y-3">
      {installed.length === 0 ? (
        <p className="text-sm text-muted-foreground">No simulator platforms are installed.</p>
      ) : (
        <ul className="space-y-1 text-sm" aria-label="Installed platforms">
          {installed.map((runtime) => (
            <li key={runtime.id} className="flex items-center gap-2">
              <span className="font-medium">
                {runtime.platform} {runtime.version}
              </span>
              {runtime.build ? (
                <span className="font-mono text-xs text-muted-foreground">{runtime.build}</span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {selected && missing.length > 0 ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void action
              .run("runtimes", "Could not add platforms.", () =>
                installRuntimes({
                  environmentId,
                  input: { ...target, path: selected.path, platforms: chosen },
                }),
              )
              .then((result) => {
                if (result?._tag === "Success") setPlatforms([]);
              });
          }}
        >
          <p className="text-xs font-medium">Add platforms to Xcode {selected.version}</p>
          <PlatformChoices
            platforms={chosen}
            onChange={setPlatforms}
            disabled={busy || action.pending !== null}
            available={missing}
          />
          {chosen.length > 0 ? <DiskLine required={required} free={status.disk.freeBytes} /> : null}
          <ActionError message={action.error} />
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={
              busy ||
              action.pending !== null ||
              chosen.length === 0 ||
              diskShortfall(required, status.disk.freeBytes) !== null
            }
          >
            {action.pending === "runtimes" ? "Starting…" : "Add platforms"}
          </Button>
        </form>
      ) : null}
    </div>
  );
}

/** Speaks job states that need the user or end the job. Keep it mounted so changes are announced. */
export function XcodeJobAnnouncer({
  job,
  status,
}: {
  job: XcodeJob | null;
  status: XcodeStatus | null;
}) {
  return (
    <p role="status" aria-live="polite" className="sr-only">
      {xcodeJobAnnouncement(job, status)}
    </p>
  );
}

function HostUnsupported({ label }: { label: string }) {
  return (
    <p className="text-sm text-muted-foreground">
      Xcode needs a Mac. {label} is not a Mac, so iOS, watchOS and tvOS devices are not available
      here. Connect to an environment running on a Mac to set up Xcode.
    </p>
  );
}

/**
 * The guided setup for a screen that needs Xcode: Apple ID first, then the Xcode version, then a
 * live install. Mount it only while its screen is visible; `onReady` fires each time the Mac gains
 * a selected Xcode with no job running.
 */
export function XcodeSetupFlow({
  environmentId,
  visible = true,
  onReady,
}: {
  environmentId: EnvironmentId;
  visible?: boolean;
  onReady?: () => void;
}) {
  const host = useXcodeHost(environmentId);
  const account = useXcodeAccount(environmentId);
  const hostName = host.mac ?? host.label;
  const { session, view } = useXcodeLive(
    environmentId,
    account.target,
    visible && host.support === "mac",
  );
  const data: XcodeView | null = view.data;
  const status = data?.status ?? null;
  const job = data?.job ?? null;
  const ready = status !== null && usableXcode(status) !== null && !isXcodeJobActive(job);
  // A retained session snapshot is stale once its stream fails; the sign-in shows the error.
  const signedIn = session.data?.state === "authenticated" && !session.error;
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
  useEffect(() => {
    if (ready) onReadyRef.current?.();
  }, [ready]);

  let body: ReactNode;
  if (host.support === "not-mac" || status?.host === "needs-mac") {
    body = <HostUnsupported label={host.label} />;
  } else if (!account.target) {
    body = <XcodeAccountPicker selection={account} />;
  } else if (view.error) {
    body = (
      <div className="space-y-2">
        <p role="alert" className="text-sm text-destructive">
          {view.error}
        </p>
        <Button size="sm" variant="outline" onClick={view.refresh}>
          Try again
        </Button>
      </div>
    );
  } else if (status === null) {
    body = <p className="text-sm text-muted-foreground">Checking Xcode on {hostName}…</p>;
  } else if (job && job.state !== "completed" && (isXcodeJobActive(job) || !ready)) {
    body = (
      <>
        <XcodeJobCard
          environmentId={environmentId}
          target={account.target}
          job={job}
          status={status}
          session={session}
          email={account.account?.email ?? "your Apple ID"}
          hostName={hostName}
        />
        {isXcodeJobActive(job) ? null : signedIn ? (
          <XcodeInstallChooser
            environmentId={environmentId}
            target={account.target}
            status={status}
          />
        ) : (
          <AppleIdSignIn
            environmentId={environmentId}
            target={account.target}
            email={account.account?.email ?? "your Apple ID"}
            session={session}
            hostName={hostName}
          />
        )}
      </>
    );
  } else if (ready) {
    // Xcode alone is not enough for simulators; offer the selected Xcode's missing platforms here.
    body = (
      <>
        <p className="flex items-center gap-1.5 text-sm">
          <CircleCheckIcon className="size-4 text-success" aria-hidden />
          Xcode {usableXcode(status)?.version} is ready on {hostName}.
        </p>
        {missingXcodePlatforms(status).includes("iOS") ? (
          <XcodeRuntimes
            environmentId={environmentId}
            target={account.target}
            status={status}
            busy={false}
          />
        ) : null}
      </>
    );
  } else if (!signedIn) {
    body = (
      <>
        {status.installed.length > 0 ? (
          <XcodeInstalledList
            environmentId={environmentId}
            target={account.target}
            status={status}
            busy={false}
          />
        ) : null}
        <AppleIdSignIn
          environmentId={environmentId}
          target={account.target}
          email={account.account?.email ?? "your Apple ID"}
          session={session}
          hostName={hostName}
        />
      </>
    );
  } else {
    body = (
      <>
        {status.installed.length > 0 ? (
          <XcodeInstalledList
            environmentId={environmentId}
            target={account.target}
            status={status}
            busy={false}
          />
        ) : null}
        <XcodeInstallChooser
          environmentId={environmentId}
          target={account.target}
          status={status}
        />
      </>
    );
  }

  return (
    <section className="mx-auto w-full max-w-xl space-y-4 p-4" aria-labelledby="xcode-setup-title">
      <header className="space-y-1">
        <h2 id="xcode-setup-title" className="text-base font-semibold">
          Set up Xcode
        </h2>
        <p className="text-sm text-muted-foreground">
          {host.support === "not-mac"
            ? `On ${host.label}`
            : `Installing on ${hostName}${host.mac ? ` · ${host.label}` : ""}. iOS simulators and devices need Xcode on this Mac.`}
        </p>
        {!host.connected ? (
          <p className="text-xs text-muted-foreground">Waiting for {host.label} to connect…</p>
        ) : null}
      </header>
      <XcodeJobAnnouncer job={job} status={status} />
      {account.target && account.accounts.length > 1 ? (
        <XcodeAccountPicker selection={account} />
      ) : null}
      {body}
    </section>
  );
}
