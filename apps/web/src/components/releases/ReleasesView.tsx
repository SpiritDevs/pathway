import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import type {
  LocalReleaseArchive,
  ReleaseAction,
  ReleaseArchiveInput,
  ReleaseJob,
  ReleaseLocalStatus,
  ReleaseOrganizer as ReleaseOrganizerData,
  ReleaseTarget,
} from "@spiritdevs/contracts/releases";
import {
  RELEASE_JOB_KIND_LABELS,
  releaseJobStatus,
  runningReleaseJob,
} from "@spiritdevs/client-runtime/state/releases";
import { squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";
import { RefreshCwIcon, RocketIcon } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import { companyListAtom } from "~/cloud/activeCompany";
import {
  appleAccountFunctions,
  useAppleAccountsClient,
  useAppleCloudQuery,
} from "~/cloud/appleAccounts";
import { useAllEnvironmentShellsBootstrapped } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { releaseEnvironment } from "~/state/releases";
import { useAtomCommand } from "~/state/use-atom-command";
import { useWorkspaceProjects } from "../projects/useWorkspaceProjects";
import {
  workspaceProjectCloudIdForCompany,
  type WorkspaceProject,
} from "../projects/workspaceProjects.logic";
import { ProjectAppStoreConnectSection } from "../settings/ProjectAppStoreConnectSection";
import { describeAppleError } from "../settings/AppleAccountsSettings.logic";
import { useCompanySettings } from "../settings/company/useCompanySettings";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Progress } from "../ui/progress";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { WorkspaceViewFrame } from "../workspace/WorkspaceViewFrame";
import { ReleaseConfirmDialog } from "./ReleaseConfirmDialog";
import { ArchiveList, ReleaseOrganizer } from "./ReleaseOrganizer";
import {
  archiveDraftProblem,
  buildLabel,
  describeReleaseFailure,
  EMPTY_ARCHIVE_DRAFT,
  formatBytes,
  processedBuilds,
  RELEASE_PLATFORMS,
  releasePlatformLabel,
  resolveArchiveProjectPath,
  type ArchiveDraft,
  type ReleasesSearch,
} from "./Releases.logic";
import {
  PUBLISHING_DESCRIPTION,
  ReleasePublishingToggle,
  useReleasePublishing,
} from "./ReleasePublishingToggle";

type LocalStatus = typeof ReleaseLocalStatus.Type;

/** Apple reads and job streams stop while the window is hidden. */
function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => typeof document === "undefined" || document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const update = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);
  return visible;
}

/** `/releases`: archive, upload, TestFlight, App Store review and the Organizer for one project. */
export function ReleasesView({
  search,
  onSearch,
}: {
  search: ReleasesSearch;
  onSearch: (patch: Partial<ReleasesSearch>) => void;
}) {
  const projects = useWorkspaceProjects();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const project =
    search.project === undefined
      ? null
      : (projects.find((candidate) => candidate.projectKey === search.project) ?? null);
  const title = project ? `${project.displayName} · Releases` : "Releases";
  return (
    <WorkspaceViewFrame title={title}>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto max-w-4xl space-y-4">
          {search.project === undefined || (bootstrapped && project === null) ? (
            <ProjectChooser
              projects={projects}
              missing={search.project !== undefined}
              onChoose={(projectKey) => onSearch({ project: projectKey })}
            />
          ) : project === null ? (
            <p className="text-sm text-muted-foreground">Loading project…</p>
          ) : (
            <ProjectReleases
              key={project.projectKey}
              project={project}
              tab={search.tab === "organizer" ? "organizer" : "release"}
              intentId={search.intent ?? null}
              onSearch={onSearch}
            />
          )}
        </div>
      </div>
    </WorkspaceViewFrame>
  );
}

function ProjectChooser({
  projects,
  missing,
  onChoose,
}: {
  projects: ReadonlyArray<WorkspaceProject>;
  missing: boolean;
  onChoose: (projectKey: string) => void;
}) {
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight">Releases</h1>
        <p className="text-sm text-muted-foreground">
          {missing
            ? "That project is no longer available. Choose another."
            : "Choose the project to archive and release. Releases use the App Store Connect app linked to the project."}
        </p>
      </div>
      {projects.length === 0 ? (
        <p className="text-sm text-muted-foreground">No projects yet.</p>
      ) : (
        <ul className="divide-y rounded-lg border">
          {projects.map((project) => (
            <li key={project.projectKey}>
              <button
                type="button"
                className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-accent"
                onClick={() => onChoose(project.projectKey)}
              >
                <RocketIcon className="size-4 text-muted-foreground" aria-hidden />
                {project.displayName}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface Checkout {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly workspaceRoot: string;
}

function ProjectReleases({
  project,
  tab,
  intentId,
  onSearch,
}: {
  project: WorkspaceProject;
  tab: "release" | "organizer";
  intentId: string | null;
  onSearch: (patch: Partial<ReleasesSearch>) => void;
}) {
  const companies = useAtomValue(companyListAtom) ?? [];
  const settings = useCompanySettings();
  const { environments } = useEnvironments();
  const owningCompany =
    companies.find(
      (company) =>
        company.id === settings.companyId && project.companyIds.includes(String(company.id)),
    ) ??
    companies.find((company) => project.companyIds.includes(String(company.id))) ??
    null;
  const cloudProjectId =
    owningCompany === null
      ? null
      : workspaceProjectCloudIdForCompany(project, String(owningCompany.id));
  const companyId = (owningCompany?.id ?? null) as CompanyId | null;
  const client = useAppleAccountsClient();
  const link = useAppleCloudQuery(
    client,
    appleAccountFunctions.projectLink,
    companyId && cloudProjectId ? { companyId, projectId: cloudProjectId } : null,
  );

  // Archives build from a checkout, so only connected environments holding one are offered.
  const checkouts = useMemo(() => {
    const seen = new Map<EnvironmentId, Checkout>();
    for (const member of project.group?.memberProjects ?? []) {
      const environment = environments.find(
        (candidate) => candidate.environmentId === member.environmentId,
      );
      if (
        seen.has(member.environmentId) ||
        member.workspaceRoot == null ||
        environment?.connection.phase !== "connected"
      )
        continue;
      seen.set(member.environmentId, {
        environmentId: member.environmentId,
        label: environment.label,
        workspaceRoot: member.workspaceRoot,
      });
    }
    return [...seen.values()];
  }, [environments, project.group]);
  const [chosenEnvironmentId, setChosenEnvironmentId] = useState<EnvironmentId | null>(null);
  const checkout =
    checkouts.find((candidate) => candidate.environmentId === chosenEnvironmentId) ??
    checkouts[0] ??
    null;
  const otherMacs = environments
    .filter(
      (environment) =>
        environment.connection.phase === "connected" &&
        environment.descriptor?.platform.os === "darwin" &&
        environment.environmentId !== checkout?.environmentId,
    )
    .map((environment) => ({ environmentId: environment.environmentId, label: environment.label }));

  if (companyId === null || cloudProjectId === null) {
    return (
      <Notice>
        Releases need this project to sync to a company, so it can be linked to App Store Connect.
      </Notice>
    );
  }
  if (link.error) {
    return (
      <Notice tone="error">
        {describeAppleError(link.error, { fallback: "Could not load the linked app." }).message}
      </Notice>
    );
  }
  if (link.data === undefined) return <Notice>Loading the linked app…</Notice>;
  if (link.data === null) {
    const environmentId = checkout?.environmentId ?? project.group?.environmentId ?? null;
    return environmentId === null ? (
      <Notice>Open this project on an environment to link it to App Store Connect.</Notice>
    ) : (
      <ProjectAppStoreConnectSection
        companyId={companyId}
        projectId={cloudProjectId}
        environmentId={environmentId}
      />
    );
  }

  const target: ReleaseTarget = {
    companyId,
    accountId: link.data.accountId,
    teamId: link.data.teamId,
    appId: link.data.app.id,
  };
  return (
    <>
      <header className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-xl font-semibold tracking-tight">{link.data.app.name}</h1>
          <p className="font-mono text-xs text-muted-foreground">{link.data.app.bundleId}</p>
        </div>
        <ReleasePublishingToggle target={target} appName={link.data.app.name} />
      </header>
      {checkout === null ? (
        <Notice>
          Connect to an environment that has a checkout of {project.displayName} on a Mac to archive
          and release.
        </Notice>
      ) : (
        <AppReleases
          key={`${checkout.environmentId}:${target.accountId}:${target.teamId}:${target.appId}`}
          target={target}
          appName={link.data.app.name}
          checkout={checkout}
          checkouts={checkouts}
          onChooseCheckout={setChosenEnvironmentId}
          otherMacs={otherMacs}
          tab={tab}
          intentId={intentId}
          onSearch={onSearch}
        />
      )}
    </>
  );
}

function Notice({ children, tone }: { children: ReactNode; tone?: "error" }) {
  return (
    <p
      role={tone === "error" ? "alert" : undefined}
      className={
        tone === "error"
          ? "rounded-lg border px-4 py-3 text-sm text-destructive"
          : "rounded-lg border px-4 py-3 text-sm text-muted-foreground"
      }
    >
      {children}
    </p>
  );
}

function AppReleases({
  target,
  appName,
  checkout,
  checkouts,
  onChooseCheckout,
  otherMacs,
  tab,
  intentId,
  onSearch,
}: {
  target: ReleaseTarget;
  appName: string;
  checkout: Checkout;
  checkouts: ReadonlyArray<Checkout>;
  onChooseCheckout: (environmentId: EnvironmentId) => void;
  otherMacs: ReadonlyArray<{ environmentId: EnvironmentId; label: string }>;
  tab: "release" | "organizer";
  intentId: string | null;
  onSearch: (patch: Partial<ReleasesSearch>) => void;
}) {
  const environmentId = checkout.environmentId;
  const visible = useDocumentVisible();
  // One subscription while the view is visible; closing it also ends the brief Apple cache.
  const view = useEnvironmentQuery(
    visible ? releaseEnvironment.view({ environmentId, input: target }) : null,
  );
  const local = view.data?.local ?? null;
  const organizer = view.data?.organizer ?? null;
  const running = runningReleaseJob(local?.jobs ?? []);
  const publishing = useReleasePublishing(target);
  const prepareCommand = useAtomCommand(releaseEnvironment.prepare, { reportFailure: false });
  const refreshCommand = useAtomCommand(releaseEnvironment.refresh, { reportFailure: false });
  const [preparing, setPreparing] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploadArchive, setUploadArchive] = useState<LocalReleaseArchive | null>(null);

  /** Agents use the same contract; this only creates a pending intent for the dialog. */
  const prepare = async (action: ReleaseAction, onEnvironment: EnvironmentId = environmentId) => {
    if (preparing) return;
    setPreparing(true);
    setError(null);
    const result = await prepareCommand({
      environmentId: onEnvironment,
      input: { ...target, action },
    });
    setPreparing(false);
    if (result._tag === "Failure") {
      setError(
        describeReleaseFailure(squashAtomCommandFailure(result), "The release was not prepared."),
      );
      return;
    }
    onSearch({ intent: result.value.id });
  };
  const refresh = async () => {
    setRefreshing(true);
    const result = await refreshCommand({ environmentId, input: target });
    setRefreshing(false);
    if (result._tag === "Failure") {
      setError(describeReleaseFailure(squashAtomCommandFailure(result), "Could not refresh."));
    }
  };
  const upload = (archive: LocalReleaseArchive, onEnvironment: EnvironmentId) => {
    setUploadArchive(archive);
    void prepare(
      {
        kind: "upload",
        archiveId: archive.id,
        artifactSha256: archive.artifactSha256,
        version: archive.version,
        buildNumber: archive.buildNumber,
        platform: archive.platform,
      },
      onEnvironment,
    );
  };
  const busy = preparing || running !== null;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Releases" className="flex gap-1 rounded-lg border p-0.5">
          {(["release", "organizer"] as const).map((value) => (
            <Button
              key={value}
              role="tab"
              aria-selected={tab === value}
              size="xs"
              variant={tab === value ? "secondary" : "ghost"}
              onClick={() => onSearch({ tab: value === "organizer" ? "organizer" : undefined })}
            >
              {value === "release" ? "Release" : "Organizer"}
            </Button>
          ))}
        </div>
        <CheckoutPicker checkouts={checkouts} value={environmentId} onChange={onChooseCheckout} />
        <span className="ml-auto text-xs text-muted-foreground">
          {organizer ? `Updated ${new Date(organizer.fetchedAt).toLocaleTimeString()}` : null}
        </span>
        <Button
          size="xs"
          variant="outline"
          disabled={refreshing || !visible}
          onClick={() => void refresh()}
        >
          <RefreshCwIcon className="size-3.5" />
          {refreshing ? "Refreshing…" : "Refresh"}
        </Button>
      </div>
      {publishing.data && !publishing.data.enabled ? (
        <Notice>
          Publishing is off for {appName}. You can archive and prepare uploads, but nothing is sent
          to Apple until publishing is on and you confirm. {PUBLISHING_DESCRIPTION}
        </Notice>
      ) : null}
      {view.error ? (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border px-4 py-3">
          <p role="alert" className="flex-1 text-sm text-destructive">
            {view.error}
          </p>
          <Button size="xs" variant="outline" onClick={view.refresh}>
            Try again
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {tab === "organizer" ? (
        <ReleaseOrganizer
          organizer={organizer}
          error={null}
          target={target}
          selected={{ environmentId, local }}
          otherEnvironments={otherMacs}
          busy={busy}
          onUpload={upload}
        />
      ) : (
        <ReleaseSteps
          target={target}
          checkout={checkout}
          local={local}
          organizer={organizer}
          running={running}
          busy={busy}
          onPrepare={(action) => void prepare(action)}
          onUpload={upload}
          onOpenOrganizer={() => onSearch({ tab: "organizer" })}
        />
      )}
      <ReleaseConfirmDialog
        intentId={intentId}
        context={{
          appName,
          organizer,
          archives: [...(local?.archives ?? []), ...(uploadArchive ? [uploadArchive] : [])],
        }}
        onClose={() => onSearch({ intent: undefined })}
      />
    </>
  );
}

function CheckoutPicker({
  checkouts,
  value,
  onChange,
}: {
  checkouts: ReadonlyArray<Checkout>;
  value: EnvironmentId;
  onChange: (environmentId: EnvironmentId) => void;
}) {
  if (checkouts.length < 2) {
    return (
      <span className="text-xs text-muted-foreground">
        on {checkouts.find((checkout) => checkout.environmentId === value)?.label}
      </span>
    );
  }
  return (
    <Select
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger size="sm" aria-label="Environment" className="w-auto">
        <SelectValue>
          {checkouts.find((checkout) => checkout.environmentId === value)?.label}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {checkouts.map((checkout) => (
          <SelectItem key={checkout.environmentId} value={checkout.environmentId}>
            {checkout.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function Step({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border">
      <h2 className="border-b px-4 py-2.5 text-sm font-medium">{title}</h2>
      <div className="space-y-3 px-4 py-3">{children}</div>
    </section>
  );
}

function ReleaseSteps({
  target,
  checkout,
  local,
  organizer,
  running,
  busy,
  onPrepare,
  onUpload,
  onOpenOrganizer,
}: {
  target: ReleaseTarget;
  checkout: Checkout;
  local: LocalStatus | null;
  organizer: ReleaseOrganizerData | null;
  running: ReleaseJob | null;
  busy: boolean;
  onPrepare: (action: ReleaseAction) => void;
  onUpload: (archive: LocalReleaseArchive, environmentId: EnvironmentId) => void;
  onOpenOrganizer: () => void;
}) {
  const [lastArchive, setLastArchive] = useState<ReleaseArchiveInput | null>(null);
  return (
    <div className="space-y-4">
      <JobList
        target={target}
        environmentId={checkout.environmentId}
        jobs={local?.jobs ?? null}
        lastArchive={lastArchive}
        busy={busy}
        onArchived={setLastArchive}
        onOpenOrganizer={onOpenOrganizer}
      />
      <Step title="1. Archive">
        <ArchiveForm
          target={target}
          checkout={checkout}
          disabled={busy}
          running={running}
          onArchived={setLastArchive}
        />
      </Step>
      <Step title="2. Upload">
        <ArchiveList
          environmentId={checkout.environmentId}
          status={local}
          error={null}
          busy={busy}
          onUpload={onUpload}
        />
      </Step>
      <Step title="3. TestFlight">
        <TestFlightForm organizer={organizer} disabled={busy} onPrepare={onPrepare} />
      </Step>
      <Step title="4. App Store review">
        <AppStoreForm organizer={organizer} disabled={busy} onPrepare={onPrepare} />
      </Step>
    </div>
  );
}

function JobList({
  target,
  environmentId,
  jobs,
  lastArchive,
  busy,
  onArchived,
  onOpenOrganizer,
}: {
  target: ReleaseTarget;
  environmentId: EnvironmentId;
  jobs: ReadonlyArray<ReleaseJob> | null;
  lastArchive: ReleaseArchiveInput | null;
  busy: boolean;
  onArchived: (input: ReleaseArchiveInput) => void;
  onOpenOrganizer: () => void;
}) {
  const cancel = useAtomCommand(releaseEnvironment.cancel, { reportFailure: false });
  const archive = useAtomCommand(releaseEnvironment.archive, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  const recent = [...(jobs ?? [])].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);
  if (recent.length === 0 && error === null) return null;

  const stop = async (job: ReleaseJob) => {
    setError(null);
    const result = await cancel({ environmentId, input: { ...target, jobId: job.id } });
    if (result._tag === "Failure") {
      setError(describeReleaseFailure(squashAtomCommandFailure(result), "Could not stop the job."));
    }
  };
  const retryArchive = async (input: ReleaseArchiveInput) => {
    setError(null);
    const result = await archive({ environmentId, input });
    if (result._tag === "Failure") {
      setError(describeReleaseFailure(squashAtomCommandFailure(result), "Could not archive."));
    } else onArchived(input);
  };

  return (
    <Step title="Activity">
      <ul aria-live="polite" className="space-y-3">
        {recent.map((job) => (
          <li key={job.id} className="space-y-1.5 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{RELEASE_JOB_KIND_LABELS[job.kind]}</span>
              <span
                className={job.state === "failed" ? "text-destructive" : "text-muted-foreground"}
              >
                {releaseJobStatus(job)}
              </span>
              <span className="ml-auto flex gap-2">
                {job.state === "running" ? (
                  <Button size="xs" variant="outline" onClick={() => void stop(job)}>
                    Stop
                  </Button>
                ) : null}
                {job.state !== "running" &&
                job.state !== "completed" &&
                job.kind === "archive" &&
                lastArchive !== null ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void retryArchive(lastArchive)}
                  >
                    Try again
                  </Button>
                ) : null}
                {job.state !== "running" && job.kind !== "archive" ? (
                  <Button size="xs" variant="ghost" onClick={onOpenOrganizer}>
                    Check Organizer
                  </Button>
                ) : null}
              </span>
            </div>
            {job.state === "running" && job.progress ? (
              <div className="space-y-0.5">
                <Progress
                  aria-label="Upload progress"
                  value={job.progress.total > 0 ? job.progress.bytes / job.progress.total : 0}
                />
                <p className="text-xs text-muted-foreground">
                  {formatBytes(job.progress.bytes)} of {formatBytes(job.progress.total)}
                </p>
              </div>
            ) : null}
            {job.state !== "running" && job.state !== "completed" && job.kind !== "archive" ? (
              <p className="text-xs text-muted-foreground">
                Apple may have received part of this. Check the Organizer, then prepare it again if
                needed.
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </Step>
  );
}

function ArchiveForm({
  target,
  checkout,
  disabled,
  running,
  onArchived,
}: {
  target: ReleaseTarget;
  checkout: Checkout;
  disabled: boolean;
  running: ReleaseJob | null;
  onArchived: (input: ReleaseArchiveInput) => void;
}) {
  const archive = useAtomCommand(releaseEnvironment.archive, { reportFailure: false });
  const [draft, setDraft] = useState<ArchiveDraft>(EMPTY_ARCHIVE_DRAFT);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = archiveDraftProblem(draft);
  const submit = async () => {
    if (problem !== null || pending) return;
    const input: ReleaseArchiveInput = {
      ...target,
      projectPath: resolveArchiveProjectPath(checkout.workspaceRoot, draft.projectFile),
      scheme: draft.scheme.trim(),
      version: draft.version.trim(),
      platform: draft.platform,
    };
    setPending(true);
    setError(null);
    const result = await archive({ environmentId: checkout.environmentId, input });
    setPending(false);
    if (result._tag === "Failure") {
      setError(describeReleaseFailure(squashAtomCommandFailure(result), "Could not archive."));
      return;
    }
    onArchived(input);
  };
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-xs text-muted-foreground">
        Archives build on {checkout.label} from{" "}
        <span className="font-mono">{checkout.workspaceRoot}</span>. Pathway picks the next build
        number for you.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs">
          <span className="font-medium">Project or workspace</span>
          <Input
            value={draft.projectFile}
            placeholder="MyApp.xcworkspace"
            onChange={(event) => setDraft({ ...draft, projectFile: event.target.value })}
          />
        </label>
        <label className="space-y-1 text-xs">
          <span className="font-medium">Scheme</span>
          <Input
            value={draft.scheme}
            placeholder="MyApp"
            onChange={(event) => setDraft({ ...draft, scheme: event.target.value })}
          />
        </label>
        <label className="space-y-1 text-xs">
          <span className="font-medium">Version</span>
          <Input
            value={draft.version}
            placeholder="1.0"
            onChange={(event) => setDraft({ ...draft, version: event.target.value })}
          />
        </label>
        <div className="space-y-1 text-xs">
          <span className="font-medium">Platform</span>
          <Select
            value={draft.platform}
            onValueChange={(value) => {
              if (value !== null) setDraft({ ...draft, platform: value });
            }}
          >
            <SelectTrigger size="sm" aria-label="Platform">
              <SelectValue>{releasePlatformLabel(draft.platform)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {RELEASE_PLATFORMS.map((platform) => (
                <SelectItem key={platform.value} value={platform.value}>
                  {platform.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : draft.projectFile && problem ? (
        <p className="text-xs text-muted-foreground">{problem}</p>
      ) : null}
      <Button type="submit" size="sm" disabled={disabled || pending || problem !== null}>
        {running?.kind === "archive" ? "Archiving…" : pending ? "Starting…" : "Archive"}
      </Button>
    </form>
  );
}

function TestFlightForm({
  organizer,
  disabled,
  onPrepare,
}: {
  organizer: ReleaseOrganizerData | null;
  disabled: boolean;
  onPrepare: (action: ReleaseAction) => void;
}) {
  const builds = processedBuilds(organizer);
  const [buildId, setBuildId] = useState<string | null>(null);
  const [groupIds, setGroupIds] = useState<ReadonlyArray<string>>([]);
  const [locale, setLocale] = useState("en-US");
  const [whatsNew, setWhatsNew] = useState("");
  const [submitForReview, setSubmitForReview] = useState(false);
  if (organizer === null) return <p className="text-xs text-muted-foreground">Loading builds…</p>;
  if (builds.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No processed builds yet. After an upload, Apple processes the build; use Refresh to check.
      </p>
    );
  }
  const ready = buildId !== null && locale.trim() !== "" && whatsNew.length <= 4000;
  return (
    <div className="space-y-3">
      <BuildPicker builds={builds} value={buildId} onChange={setBuildId} />
      <fieldset className="space-y-1 text-xs">
        <legend className="mb-1 font-medium">Groups</legend>
        {organizer.groups.length === 0 ? (
          <p className="text-muted-foreground">No groups. Create one in App Store Connect.</p>
        ) : (
          organizer.groups.map((group) => (
            <label key={group.id} className="flex items-center gap-2">
              <Checkbox
                checked={groupIds.includes(group.id)}
                onCheckedChange={(checked) =>
                  setGroupIds(
                    checked
                      ? [...groupIds, group.id]
                      : groupIds.filter((candidate) => candidate !== group.id),
                  )
                }
              />
              {group.name}
              <span className="text-muted-foreground">
                {group.isInternalGroup ? "Internal" : "External"}
              </span>
            </label>
          ))
        )}
      </fieldset>
      <label className="block space-y-1 text-xs">
        <span className="font-medium">What to test</span>
        <Textarea
          value={whatsNew}
          maxLength={4000}
          onChange={(event) => setWhatsNew(event.target.value)}
        />
      </label>
      <div className="flex flex-wrap items-center gap-4 text-xs">
        <label className="flex items-center gap-2">
          <span className="font-medium">Language</span>
          <Input
            className="w-24"
            value={locale}
            onChange={(event) => setLocale(event.target.value)}
          />
        </label>
        <label className="flex items-center gap-2">
          <Checkbox
            checked={submitForReview}
            onCheckedChange={(checked) => setSubmitForReview(checked === true)}
          />
          Submit for beta review (needed for external groups)
        </label>
      </div>
      <Button
        size="sm"
        disabled={disabled || !ready}
        onClick={() =>
          buildId !== null &&
          onPrepare({
            kind: "testflight",
            buildId,
            groupIds,
            locale: locale.trim(),
            whatsNew,
            submitForReview,
          })
        }
      >
        Review and send…
      </Button>
    </div>
  );
}

function AppStoreForm({
  organizer,
  disabled,
  onPrepare,
}: {
  organizer: ReleaseOrganizerData | null;
  disabled: boolean;
  onPrepare: (action: ReleaseAction) => void;
}) {
  const builds = processedBuilds(organizer);
  const [buildId, setBuildId] = useState<string | null>(null);
  const [versionId, setVersionId] = useState<string | null>(null);
  if (organizer === null) return <p className="text-xs text-muted-foreground">Loading versions…</p>;
  if (organizer.versions.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        Create an App Store version in App Store Connect, then use Refresh.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <BuildPicker builds={builds} value={buildId} onChange={setBuildId} />
        <div className="space-y-1 text-xs">
          <span className="font-medium">App Store version</span>
          <Select value={versionId} onValueChange={setVersionId}>
            <SelectTrigger size="sm" aria-label="App Store version">
              <SelectValue placeholder="Choose a version">
                {(() => {
                  const version = organizer.versions.find((v) => v.id === versionId);
                  return version
                    ? `${version.version} · ${releasePlatformLabel(version.platform)}`
                    : null;
                })()}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {organizer.versions.map((version) => (
                <SelectItem key={version.id} value={version.id}>
                  {version.version} · {releasePlatformLabel(version.platform)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
      </div>
      <Button
        size="sm"
        disabled={disabled || buildId === null || versionId === null}
        onClick={() =>
          buildId !== null &&
          versionId !== null &&
          onPrepare({ kind: "app-store", buildId, versionId })
        }
      >
        Review and submit…
      </Button>
    </div>
  );
}

function BuildPicker({
  builds,
  value,
  onChange,
}: {
  builds: ReturnType<typeof processedBuilds>;
  value: string | null;
  onChange: (buildId: string | null) => void;
}) {
  const selected = builds.find((build) => build.id === value);
  return (
    <div className="space-y-1 text-xs">
      <span className="font-medium">Build</span>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger size="sm" aria-label="Build">
          <SelectValue placeholder="Choose a build">
            {selected ? buildLabel(selected) : null}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {builds.map((build) => (
            <SelectItem key={build.id} value={build.id}>
              {buildLabel(build)}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}
