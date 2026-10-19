import { useState } from "react";
import { Button } from "../ui/button";
import { useMailQuery, type ConnectedMailCloud } from "./connectedMailCloud";
import type { ConnectedMailAccount } from "./connectedMail.types";

type DraftJob = { id: string; subject: string; status: string; lastError?: string };

export function MailDraftJobs({
  cloud,
  account,
}: {
  cloud: ConnectedMailCloud;
  account: ConnectedMailAccount;
}) {
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const jobs = useMailQuery<{ jobs: DraftJob[]; nextCursor: string | null }>(
    cloud.client,
    cloud.scope,
    "mail:listDraftJobs",
    cloud.ready
      ? { companyId: cloud.companyId!, accountId: account.id, ...(cursor ? { cursor } : {}) }
      : null,
  );
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const retry = async (jobId: string) => {
    setBusy(jobId);
    setError(undefined);
    try {
      await cloud.request("mail:retryDraftJob", { jobId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <>
      {jobs.value?.jobs.map((job) => (
        <div key={job.id} className="space-y-2 border-b p-3">
          <p className="truncate text-sm">Reply to {job.subject || "No subject"}</p>
          <p className="text-xs text-muted-foreground">
            {job.status === "failed"
              ? "Draft generation failed"
              : job.status === "running"
                ? "Generating reply…"
                : "Waiting for your mail environment"}
          </p>
          {job.lastError ? <p className="text-xs text-destructive">{job.lastError}</p> : null}
          {job.status === "failed" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={Boolean(busy) || account.status !== "active"}
              onClick={() => void retry(job.id)}
            >
              {busy === job.id ? "Retrying…" : "Retry draft"}
            </Button>
          ) : null}
        </div>
      ))}
      {cursors.length > 0 || jobs.value?.nextCursor ? (
        <div className="flex gap-2 p-3">
          <Button
            size="xs"
            variant="outline"
            disabled={cursors.length === 0}
            onClick={() => setCursors((current) => current.slice(0, -1))}
          >
            Previous requests
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={!jobs.value?.nextCursor}
            onClick={() => {
              const next = jobs.value?.nextCursor;
              if (next) setCursors((current) => [...current, next]);
            }}
          >
            Next requests
          </Button>
        </div>
      ) : null}
      {error || jobs.error ? (
        <p role="alert" className="p-3 text-xs text-destructive">
          {error || jobs.error}
        </p>
      ) : null}
    </>
  );
}
