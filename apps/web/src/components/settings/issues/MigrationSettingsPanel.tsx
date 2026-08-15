import { useAuth } from "@clerk/react";
import {
  ISSUE_IMPORT_ENTITY_KINDS,
  ISSUE_IMPORT_RESULT_KINDS,
  type IssueImportExecuteResult,
  type IssueImportPreviewResult,
  type IssueImportRun,
} from "@spiritdevs/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@spiritdevs/client-runtime/state/runtime";
import { AlertTriangleIcon, CheckCircle2Icon, CloudUploadIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { makeIssueImportClient, type IssueImportClient } from "../../../cloud/issueImportClient";
import { resolveCloudSyncConvexUrl } from "../../../cloud/publicConfig";
import { makeClerkConvexTokenFetcher } from "../../../cloud/syncTransportAuth";
import { useIssueImportExecute, useIssueImportPreview } from "../../../state/issueImport";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Input } from "../../ui/input";
import { Progress } from "../../ui/progress";
import { Spinner } from "../../ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../../ui/table";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settingsLayout";
import { searchableSetting } from "../settingsSearch";
import { issueKeyPrefixError, normalizeIssueKeyPrefix } from "./issuesSettings.logic";
import { useCompanySettings } from "../company/useCompanySettings";

const KIND_LABELS: Readonly<Record<string, string>> = {
  cloudProject: "Projects",
  issue: "Issues",
  issueStatus: "Statuses",
  issueLabel: "Labels",
  issueMilestone: "Milestones",
  issueCycle: "Cycles",
  issueTodo: "Todos",
  issueRelation: "Relations",
  issueComment: "Comments",
  issueAttachment: "Attachments",
  issueView: "Views",
  issueAuditEvent: "Audit events",
  issueThreadLink: "Thread links",
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The issue migration request failed.";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function runIsLive(run: IssueImportRun | null): boolean {
  return run?.state === "created" || run?.state === "applying";
}

export function IssueImportProgressView({
  run,
  preview,
}: {
  run: IssueImportRun;
  preview: IssueImportPreviewResult;
}) {
  const expected = Object.values(preview.preview.counts).reduce((total, count) => total + count, 0);
  const completed = ISSUE_IMPORT_ENTITY_KINDS.reduce(
    (total, kind) => total + run.progress[kind],
    0,
  );
  const ratio = expected === 0 ? (run.state === "completed" ? 1 : 0) : completed / expected;
  return (
    <div className="space-y-3 rounded-xl border border-border p-3 sm:p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-medium">Migration {run.state}</p>
          <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{run.id}</p>
        </div>
        <span className="rounded-md bg-accent px-2 py-1 text-xs capitalize text-accent-foreground">
          {run.state}
        </span>
      </div>
      <Progress value={ratio} aria-label="Issue migration progress" />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Kind</TableHead>
            <TableHead className="text-right">Imported</TableHead>
            <TableHead className="text-right">Planned</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>{KIND_LABELS.cloudProject}</TableCell>
            <TableCell className="text-right tabular-nums">{run.progress.cloudProject}</TableCell>
            <TableCell className="text-right text-muted-foreground">—</TableCell>
          </TableRow>
          {ISSUE_IMPORT_ENTITY_KINDS.map((kind) => (
            <TableRow key={kind}>
              <TableCell>{KIND_LABELS[kind]}</TableCell>
              <TableCell className="text-right tabular-nums">{run.progress[kind]}</TableCell>
              <TableCell className="text-right tabular-nums">
                {preview.preview.counts[kind]}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

export function IssueImportResultView({ result }: { result: IssueImportExecuteResult }) {
  return (
    <div className="space-y-3 rounded-xl border border-success/30 bg-success/5 p-3 sm:p-4">
      <div className="flex items-center gap-2">
        <CheckCircle2Icon className="size-4 text-success" />
        <p className="text-sm font-medium">Cloud issue migration completed</p>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Kind</TableHead>
            <TableHead className="text-right">Applied</TableHead>
            <TableHead className="text-right">Already applied</TableHead>
            <TableHead className="text-right">Rejected</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {ISSUE_IMPORT_RESULT_KINDS.map((kind) => (
            <TableRow key={kind}>
              <TableCell>{KIND_LABELS[kind]}</TableCell>
              <TableCell className="text-right tabular-nums">
                {result.counts[kind].applied}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {result.counts[kind].alreadyApplied}
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {result.counts[kind].rejected}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="text-xs text-muted-foreground">
        {result.attachmentUploads.length} attachment uploads finalized · {result.rejects.length}{" "}
        rejected records
        {result.resumed ? " · resumed from the import ledger" : ""}
      </p>
      {result.rejects.length > 0 ? (
        <ul className="space-y-1 text-xs text-destructive-foreground">
          {result.rejects.map((reject) => (
            <li key={`${reject.entityKind}:${reject.entityId}`}>
              {KIND_LABELS[reject.entityKind] ?? reject.entityKind} {reject.entityId}:{" "}
              {reject.message}
            </li>
          ))}
        </ul>
      ) : null}
      {result.attachmentUploads.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs font-medium">Attachment uploads</p>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {result.attachmentUploads.map((upload) => (
              <li key={upload.attachmentId}>
                {upload.attachmentId}: {upload.status} · {formatBytes(upload.byteSize)}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export function MigrationSettingsPanel() {
  const settings = useCompanySettings();
  const { getToken, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const requestPreview = useIssueImportPreview();
  const executeImport = useIssueImportExecute();
  const convexUrl = resolveCloudSyncConvexUrl();
  const client = useMemo<IssueImportClient | null>(() => {
    if (!isSignedIn || convexUrl === null) return null;
    return makeIssueImportClient({
      convexUrl,
      fetchToken: makeClerkConvexTokenFetcher(getToken),
    });
  }, [convexUrl, getToken, isSignedIn]);

  const [prefix, setPrefix] = useState(settings.activeCompany?.issueKeyPrefix ?? "ISS");
  const [preview, setPreview] = useState<IssueImportPreviewResult | null>(null);
  const [run, setRun] = useState<IssueImportRun | null>(null);
  const [result, setResult] = useState<IssueImportExecuteResult | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [abandoning, setAbandoning] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const autoPreviewKey = useRef<string | null>(null);

  const membershipId = settings.currentMembership?.membershipId ?? null;
  const companyId = settings.companyId;
  const normalized = normalizeIssueKeyPrefix(prefix);
  const prefixError = issueKeyPrefixError(prefix);
  const canManage =
    settings.permissions.status === "known" &&
    (settings.permissions.isOwner || settings.permissions.company.has("company.manage"));

  useEffect(() => () => void client?.close(), [client]);

  useEffect(() => {
    const companyPrefix = settings.activeCompany?.issueKeyPrefix;
    if (preview === null && companyPrefix) setPrefix(companyPrefix);
  }, [preview, settings.activeCompany?.issueKeyPrefix]);

  const loadPreview = useCallback(async () => {
    if (companyId === null || membershipId === null || prefixError !== null) return;
    setLoadingPreview(true);
    setError(null);
    setResult(null);
    setPreview(null);
    setRun(null);
    const outcome = await requestPreview({
      companyId,
      importingMembershipId: membershipId,
      selectedIssueKeyPrefix: normalized,
    });
    setLoadingPreview(false);
    if (outcome._tag === "Failure") {
      if (!isAtomCommandInterrupted(outcome))
        setError(errorMessage(squashAtomCommandFailure(outcome)));
      return;
    }
    setPreview(outcome.value);
    setConfirming(false);
    setConfirmed(false);
  }, [companyId, membershipId, normalized, prefixError, requestPreview]);

  useEffect(() => {
    if (loadingPreview || companyId === null || membershipId === null || prefixError !== null)
      return;
    const key = `${companyId}\u0000${membershipId}\u0000${normalized}`;
    if (autoPreviewKey.current === key) return;
    autoPreviewKey.current = key;
    void loadPreview();
  }, [companyId, loadPreview, loadingPreview, membershipId, normalized, prefixError]);

  useEffect(() => {
    setRun(null);
    if (client === null || companyId === null || preview === null) return;
    return client.subscribeRun({ companyId, runId: preview.runId }, setRun, (subscriptionError) =>
      setError(subscriptionError.message),
    );
  }, [client, companyId, preview]);

  const execute = useCallback(async () => {
    if (companyId === null || membershipId === null || preview === null) return;
    setExecuting(true);
    setError(null);
    const outcome = await executeImport({
      companyId,
      importingMembershipId: membershipId,
      selectedIssueKeyPrefix: preview.selectedIssueKeyPrefix,
    });
    setExecuting(false);
    if (outcome._tag === "Failure") {
      if (!isAtomCommandInterrupted(outcome))
        setError(errorMessage(squashAtomCommandFailure(outcome)));
      return;
    }
    setResult(outcome.value);
    setRun(outcome.value.finalRun);
  }, [companyId, executeImport, membershipId, preview]);

  const start = useCallback(async () => {
    if (client === null || companyId === null || preview === null) return;
    setExecuting(true);
    setError(null);
    try {
      const created = await client.start({
        companyId,
        id: preview.runId,
        sourceEnvironmentId: preview.sourceEnvironmentId,
        selectedIssueKeyPrefix: preview.selectedIssueKeyPrefix,
      });
      setRun(created);
      setConfirming(false);
      setConfirmed(false);
    } catch (startError) {
      setExecuting(false);
      setError(errorMessage(startError));
      return;
    }
    setExecuting(false);
    await execute();
  }, [client, companyId, execute, preview]);

  const abandon = useCallback(async () => {
    if (client === null || companyId === null || run === null) return;
    setAbandoning(true);
    setError(null);
    try {
      setRun(await client.abandon({ companyId, runId: run.id }));
    } catch (abandonError) {
      setError(errorMessage(abandonError));
    } finally {
      setAbandoning(false);
    }
  }, [client, companyId, run]);

  if (!settings.isSignedIn || companyId === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection {...searchableSetting("issue-cloud-migration")}>
          <SettingsRow
            title="Move local issues to the cloud"
            description="Sign in and select a company before previewing this migration."
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection
        {...searchableSetting("issue-cloud-migration")}
        headerAction={
          <Button
            size="xs"
            variant="ghost"
            disabled={loadingPreview || prefixError !== null}
            onClick={() => void loadPreview()}
          >
            {loadingPreview ? (
              <Spinner className="size-3.5" />
            ) : (
              <RefreshCwIcon className="size-3.5" />
            )}
            Preview
          </Button>
        }
      >
        <SettingsRow
          title="Move local issues to the cloud"
          description="Preview every local issue-domain row, then write it once to the selected cloud company with preserved ids, history, timestamps, and attachments. The cloud company must be empty."
          control={
            <Input
              nativeInput
              value={prefix}
              aria-label="Migration issue key prefix"
              className="w-28 font-mono"
              onChange={(event) => {
                setPrefix(event.currentTarget.value);
                setPreview(null);
                setRun(null);
              }}
            />
          }
        />

        {prefixError !== null ? (
          <p className="px-3 text-xs text-destructive-foreground sm:px-4">{prefixError}</p>
        ) : null}
        {error !== null ? (
          <div className="mx-3 flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive-foreground sm:mx-4">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        ) : null}

        {preview !== null ? (
          <div className="mx-3 space-y-4 sm:mx-4">
            <div className="space-y-3 rounded-xl border border-border p-3 sm:p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-sm font-medium">Import preview</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {preview.preview.issueKeyPrefix.source} →{" "}
                    {preview.preview.issueKeyPrefix.selected} ·{" "}
                    {preview.preview.issueKeyRange.first ?? "No issue keys"}
                    {preview.preview.issueKeyRange.last === null
                      ? ""
                      : ` to ${preview.preview.issueKeyRange.last}`}{" "}
                    · next {preview.preview.nextIssueNumber}
                  </p>
                </div>
                <span
                  className={`rounded-md px-2 py-1 text-xs ${preview.preflight.passed ? "bg-success/10 text-success" : "bg-warning/10 text-warning-foreground"}`}
                >
                  {preview.preflight.passed ? "Ready" : "Blocked"}
                </span>
              </div>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Kind</TableHead>
                    <TableHead className="text-right">Records</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {ISSUE_IMPORT_ENTITY_KINDS.map((kind) => (
                    <TableRow key={kind}>
                      <TableCell>{KIND_LABELS[kind]}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {preview.preview.counts[kind]}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <div className="grid gap-2 text-xs sm:grid-cols-2">
                {[
                  ["Cloud sync configured", preview.preflight.cloudSyncConfigured],
                  ["Company matches server", preview.preflight.companyMatches],
                  ["Environment linked", preview.preflight.environmentLinked],
                  ["Cloud bootstrap ready", preview.preflight.bootstrapReady],
                  ["Target company empty", preview.preflight.targetCompanyEmpty === true],
                ].map(([label, passed]) => (
                  <div
                    key={String(label)}
                    className="flex items-center justify-between gap-3 rounded-lg bg-muted/40 px-2.5 py-2"
                  >
                    <span className="text-muted-foreground">{label}</span>
                    <span className={passed ? "text-success" : "text-warning-foreground"}>
                      {passed ? "Ready" : "Blocked"}
                    </span>
                  </div>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                {preview.preview.attachments.count} attachments ·{" "}
                {formatBytes(preview.preview.attachments.totalBytes)}
              </p>
              {preview.preflight.reasons.length > 0 ? (
                <ul className="space-y-1 text-xs text-warning-foreground">
                  {preview.preflight.reasons.map((reason) => (
                    <li key={reason.code}>• {reason.message}</li>
                  ))}
                </ul>
              ) : null}
              {preview.preview.rejected.length > 0 ? (
                <div className="space-y-1">
                  <p className="text-xs font-medium text-destructive-foreground">
                    Rejected local records
                  </p>
                  <ul className="space-y-1 text-xs text-muted-foreground">
                    {preview.preview.rejected.map((reject) => (
                      <li key={`${reject.entityKind}:${reject.entityId}`}>
                        {KIND_LABELS[reject.entityKind] ?? reject.entityKind} {reject.entityId}:{" "}
                        {reject.reason}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <details className="rounded-lg border border-border px-3 py-2 text-xs">
                <summary className="cursor-pointer font-medium">
                  Fidelity details ({preview.fidelityGaps.length})
                </summary>
                <div className="mt-3 space-y-3 text-muted-foreground">
                  {preview.fidelityGaps.map((gap) => (
                    <div key={gap.entityKind}>
                      <p className="font-medium text-foreground">
                        {KIND_LABELS[gap.entityKind] ?? gap.entityKind} · {gap.verdict}
                      </p>
                      {gap.gaps.map((item) => (
                        <p key={item.fields.join(",")}>
                          {item.fields.join(", ")}: {item.normalPushBehavior}
                        </p>
                      ))}
                    </div>
                  ))}
                </div>
              </details>
            </div>

            {run !== null ? <IssueImportProgressView run={run} preview={preview} /> : null}
            {result !== null ? <IssueImportResultView result={result} /> : null}

            {runIsLive(run) && !executing ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => void execute()}>
                  <CloudUploadIcon className="size-3.5" />
                  Resume migration
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!canManage || abandoning || client === null}
                  onClick={() => void abandon()}
                >
                  {abandoning ? <Spinner className="size-3.5" /> : null}Abandon
                </Button>
              </div>
            ) : null}

            {run === null && !confirming ? (
              <Button
                size="sm"
                disabled={!preview.preflight.passed || !canManage || client === null || executing}
                onClick={() => setConfirming(true)}
              >
                <CloudUploadIcon className="size-3.5" />
                Continue to confirmation
              </Button>
            ) : null}

            {run === null && confirming ? (
              <div className="space-y-3 rounded-xl border border-warning/40 bg-warning/5 p-3 sm:p-4">
                <p className="text-sm font-medium">Confirm cloud write</p>
                <p className="text-xs text-muted-foreground">
                  This writes the previewed local issue data into{" "}
                  {settings.activeCompany?.name ?? "the selected company"}. It is only allowed while
                  that company's issue domain is empty. Once applying begins, recovery uses the
                  durable import ledger.
                </p>
                <label className="flex items-start gap-2 text-xs">
                  <Checkbox
                    checked={confirmed}
                    onCheckedChange={(checked) => setConfirmed(checked === true)}
                  />
                  <span>
                    I understand this creates cloud company data and may upload attachment bytes.
                  </span>
                </label>
                <div className="flex gap-2">
                  <Button size="sm" disabled={!confirmed || executing} onClick={() => void start()}>
                    {executing ? (
                      <Spinner className="size-3.5" />
                    ) : (
                      <CloudUploadIcon className="size-3.5" />
                    )}
                    {executing ? "Starting…" : "Start migration"}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={executing}
                    onClick={() => {
                      setConfirming(false);
                      setConfirmed(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        ) : loadingPreview ? (
          <div className="mx-3 flex items-center gap-2 rounded-xl border border-border p-4 text-sm text-muted-foreground sm:mx-4">
            <Spinner className="size-4" />
            Building a read-only preview…
          </div>
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
