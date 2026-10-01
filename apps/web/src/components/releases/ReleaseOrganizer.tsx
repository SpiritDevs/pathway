import type { EnvironmentId } from "@spiritdevs/contracts";
import type {
  LocalReleaseArchive,
  ReleaseLocalStatus,
  ReleaseOrganizer as ReleaseOrganizerData,
  ReleaseTarget,
} from "@spiritdevs/contracts/releases";
import { useState, type ReactNode } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { releaseEnvironment } from "~/state/releases";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  buildLabel,
  formatAscDate,
  formatAscState,
  formatBytes,
  paginate,
  releasePlatformLabel,
} from "./Releases.logic";

const PAGE_SIZE = 10;

function Section({
  title,
  actions,
  children,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border">
      <header className="flex items-center justify-between gap-2 border-b px-4 py-2.5">
        <h2 className="text-sm font-medium">{title}</h2>
        {actions}
      </header>
      <div className="px-4 py-3">{children}</div>
    </section>
  );
}

function Pager({
  page,
  pageCount,
  onPage,
  label,
}: {
  page: number;
  pageCount: number;
  onPage: (page: number) => void;
  label: string;
}) {
  if (pageCount <= 1) return null;
  return (
    <nav aria-label={`${label} pages`} className="mt-2 flex items-center justify-end gap-2 text-xs">
      <Button size="xs" variant="outline" disabled={page === 0} onClick={() => onPage(page - 1)}>
        Previous
      </Button>
      <span className="text-muted-foreground">
        Page {page + 1} of {pageCount}
      </span>
      <Button
        size="xs"
        variant="outline"
        disabled={page >= pageCount - 1}
        onClick={() => onPage(page + 1)}
      >
        Next
      </Button>
    </nav>
  );
}

function usePage<Item>(items: ReadonlyArray<Item>) {
  const [page, setPage] = useState(0);
  return { ...paginate(items, page, PAGE_SIZE), setPage };
}

const CELL = "px-2 py-1.5 text-left align-top";

/** Apple metadata, local archives, and Upload. Rendered only while the Releases view is visible. */
export function ReleaseOrganizer({
  organizer,
  error,
  target,
  selected,
  otherEnvironments,
  busy,
  onUpload,
}: {
  organizer: ReleaseOrganizerData | null;
  error: string | null;
  target: ReleaseTarget;
  /** The selected environment's live status from the subscription. */
  selected: { environmentId: EnvironmentId; local: typeof ReleaseLocalStatus.Type | null };
  /** Other connected Macs that may hold archives for this app. */
  otherEnvironments: ReadonlyArray<{ environmentId: EnvironmentId; label: string }>;
  busy: boolean;
  onUpload: (archive: LocalReleaseArchive, environmentId: EnvironmentId) => void;
}) {
  return (
    <div className="space-y-4">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : organizer === null ? (
        <p className="text-sm text-muted-foreground">Loading App Store Connect…</p>
      ) : (
        <>
          <BuildsSection organizer={organizer} />
          <TestFlightSection organizer={organizer} />
          <ReviewSection organizer={organizer} />
        </>
      )}
      <Section title="Local archives">
        <div className="space-y-4">
          <ArchiveList
            environmentId={selected.environmentId}
            status={selected.local}
            error={null}
            busy={busy}
            onUpload={onUpload}
          />
          {otherEnvironments.map((environment) => (
            <OtherEnvironmentArchives
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environment.label}
              target={target}
              busy={busy}
              onUpload={onUpload}
            />
          ))}
        </div>
      </Section>
    </div>
  );
}

function BuildsSection({ organizer }: { organizer: ReleaseOrganizerData }) {
  const page = usePage(organizer.builds);
  return (
    <Section title={`Builds (${organizer.builds.length})`}>
      {organizer.builds.length === 0 ? (
        <p className="text-sm text-muted-foreground">No builds have been uploaded yet.</p>
      ) : (
        <>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-muted-foreground">
                <tr>
                  <th className={CELL}>Version</th>
                  <th className={CELL}>Processing</th>
                  <th className={CELL}>Beta review</th>
                  <th className={CELL}>Internal</th>
                  <th className={CELL}>External</th>
                  <th className={CELL}>Uploaded</th>
                  <th className={CELL}>Expires</th>
                </tr>
              </thead>
              <tbody>
                {page.items.map((build) => (
                  <tr key={build.id} className="border-t">
                    <td className={`${CELL} font-medium`}>{buildLabel(build)}</td>
                    <td className={CELL}>{formatAscState(build.processingState)}</td>
                    <td className={CELL}>{formatAscState(build.betaReviewState)}</td>
                    <td className={CELL}>{formatAscState(build.internalBuildState)}</td>
                    <td className={CELL}>{formatAscState(build.externalBuildState)}</td>
                    <td className={CELL}>{formatAscDate(build.uploadedDate)}</td>
                    <td className={CELL}>{formatAscDate(build.expiresAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pager label="Builds" page={page.page} pageCount={page.pageCount} onPage={page.setPage} />
        </>
      )}
    </Section>
  );
}

function TestFlightSection({ organizer }: { organizer: ReleaseOrganizerData }) {
  const testers = usePage(organizer.testers);
  return (
    <Section title="TestFlight">
      <div className="space-y-3">
        <div>
          <p className="mb-1 text-xs font-medium">Groups</p>
          {organizer.groups.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No groups. Create groups in App Store Connect.
            </p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {organizer.groups.map((group) => (
                <li key={group.id}>
                  <Badge variant="outline">
                    {group.name} · {group.isInternalGroup ? "Internal" : "External"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="mb-1 text-xs font-medium">Testers ({organizer.testers.length})</p>
          {organizer.testers.length === 0 ? (
            <p className="text-xs text-muted-foreground">No testers.</p>
          ) : (
            <>
              <ul className="space-y-1 text-xs">
                {testers.items.map((tester) => (
                  <li key={tester.id} className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      {[tester.firstName, tester.lastName].filter(Boolean).join(" ") ||
                        tester.email ||
                        tester.id}
                      {tester.email && (tester.firstName || tester.lastName) ? (
                        <span className="text-muted-foreground"> · {tester.email}</span>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground">{formatAscState(tester.state)}</span>
                  </li>
                ))}
              </ul>
              <Pager
                label="Testers"
                page={testers.page}
                pageCount={testers.pageCount}
                onPage={testers.setPage}
              />
            </>
          )}
        </div>
      </div>
    </Section>
  );
}

function ReviewSection({ organizer }: { organizer: ReleaseOrganizerData }) {
  const buildName = (id: string | null) => {
    if (id === null) return "No build";
    const build = organizer.builds.find((candidate) => candidate.id === id);
    return build ? buildLabel(build) : id;
  };
  return (
    <Section title="App Store">
      <div className="space-y-3 text-xs">
        <div>
          <p className="mb-1 font-medium">Versions</p>
          {organizer.versions.length === 0 ? (
            <p className="text-muted-foreground">
              No App Store versions. Create one in App Store Connect.
            </p>
          ) : (
            <ul className="space-y-1">
              {organizer.versions.map((version) => (
                <li key={version.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {version.version} · {releasePlatformLabel(version.platform)}
                  </span>
                  <span className="text-muted-foreground">{buildName(version.buildId)}</span>
                  <span className="ml-auto">{formatAscState(version.state)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <p className="mb-1 font-medium">Review submissions</p>
          {organizer.reviews.length === 0 ? (
            <p className="text-muted-foreground">Nothing has been submitted for review.</p>
          ) : (
            <ul className="space-y-1">
              {organizer.reviews.map((review) => (
                <li key={review.id} className="flex items-center gap-2">
                  <span>{formatAscState(review.state)}</span>
                  <span className="ml-auto text-muted-foreground">
                    {review.submittedDate ? formatAscDate(review.submittedDate) : "Not submitted"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Section>
  );
}

function OtherEnvironmentArchives({
  environmentId,
  label,
  target,
  busy,
  onUpload,
}: {
  environmentId: EnvironmentId;
  label: string;
  target: ReleaseTarget;
  busy: boolean;
  onUpload: (archive: LocalReleaseArchive, environmentId: EnvironmentId) => void;
}) {
  const status = useEnvironmentQuery(
    releaseEnvironment.localStatus({ environmentId, input: target }),
  );
  return (
    <ArchiveList
      environmentId={environmentId}
      status={status.data}
      fallbackLabel={label}
      error={status.error}
      busy={busy}
      onUpload={onUpload}
    />
  );
}

export function ArchiveList({
  environmentId,
  status,
  fallbackLabel,
  error,
  busy,
  onUpload,
}: {
  environmentId: EnvironmentId;
  status: typeof ReleaseLocalStatus.Type | null;
  fallbackLabel?: string;
  error: string | null;
  busy: boolean;
  onUpload: (archive: LocalReleaseArchive, environmentId: EnvironmentId) => void;
}) {
  const label = status?.environmentLabel ?? fallbackLabel ?? "This environment";
  const archives = [...(status?.archives ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <div>
      <p className="mb-1 text-xs font-medium">On {label}</p>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : status === null ? (
        <p className="text-xs text-muted-foreground">Loading archives…</p>
      ) : archives.length === 0 ? (
        <p className="text-xs text-muted-foreground">No archives yet.</p>
      ) : (
        <ul className="space-y-1">
          {archives.map((archive) => (
            <li key={archive.id} className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-medium">
                {archive.version} ({archive.buildNumber})
              </span>
              <span className="text-muted-foreground">
                {archive.scheme} · {releasePlatformLabel(archive.platform)} ·{" "}
                {formatBytes(archive.artifactBytes)} ·{" "}
                {new Date(archive.createdAt).toLocaleString()}
              </span>
              <Button
                className="ml-auto"
                size="xs"
                variant="outline"
                disabled={busy}
                onClick={() => onUpload(archive, environmentId)}
              >
                Upload…
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
