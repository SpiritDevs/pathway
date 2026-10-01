import {
  RELEASE_WS_METHODS,
  type ReleaseJob,
  type ReleaseLocalStatus,
  type ReleaseOrganizer,
  type ReleaseUpdate,
} from "@spiritdevs/contracts/releases";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/** What a Releases screen renders. Local job ticks and Apple metadata arrive independently. */
export interface ReleaseView {
  readonly local: typeof ReleaseLocalStatus.Type | null;
  readonly organizer: ReleaseOrganizer | null;
}

export const EMPTY_RELEASE_VIEW: ReleaseView = { local: null, organizer: null };

export function applyReleaseUpdate(view: ReleaseView, update: ReleaseUpdate): ReleaseView {
  return update.kind === "local"
    ? { local: update.local, organizer: view.organizer }
    : { local: view.local, organizer: update.organizer };
}

/** Releases and Organizer for one app on one environment. Mount only while the view is visible. */
export function createReleaseEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Folds `releases.subscribe`; the stream (and any Apple reads) close with the last watcher. */
    view: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:releases:view",
      tag: RELEASE_WS_METHODS.subscribe,
      idleTtlMs: 0,
      transform: (stream) =>
        stream.pipe(Stream.scan(EMPTY_RELEASE_VIEW, applyReleaseUpdate), Stream.drop(1)),
    }),
    /** One environment's archives and jobs without Apple reads, for archives held elsewhere. */
    localStatus: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:releases:local-status",
      tag: RELEASE_WS_METHODS.localStatus,
      staleTimeMs: 30_000,
    }),
    archive: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:releases:archive",
      tag: RELEASE_WS_METHODS.archive,
    }),
    /** Creates a pending intent only. Nothing reaches Apple until a person confirms it. */
    prepare: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:releases:prepare",
      tag: RELEASE_WS_METHODS.prepare,
    }),
    /** Call only from a confirmation the user clicked, after Cloud `confirm` succeeded. */
    execute: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:releases:execute",
      tag: RELEASE_WS_METHODS.execute,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:releases:cancel",
      tag: RELEASE_WS_METHODS.cancel,
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:releases:refresh",
      tag: RELEASE_WS_METHODS.refresh,
    }),
  };
}

export const RELEASE_JOB_KIND_LABELS: Readonly<Record<ReleaseJob["kind"], string>> = {
  archive: "Archive",
  upload: "Upload",
  testflight: "TestFlight",
  "app-store": "App Store review",
};

const RELEASE_PHASE_LABELS: Readonly<Record<string, string>> = {
  preparing: "Preparing…",
  archiving: "Archiving…",
  exporting: "Exporting…",
  uploading: "Uploading…",
  submitting: "Sending to App Store Connect…",
  completed: "Done",
  "uploaded-awaiting-processing": "Uploaded. Apple is processing the build",
};

/** Unknown phases are shown as sent, so a new server phase never reads as success. */
export function releaseJobStatus(job: ReleaseJob): string {
  switch (job.state) {
    case "running":
    case "completed":
      return RELEASE_PHASE_LABELS[job.phase] ?? job.phase;
    case "failed":
      return job.error?.message ?? "Failed";
    case "cancelled":
      return "Stopped";
    case "interrupted":
      return "Interrupted when the environment restarted";
  }
}

/** The environment runs one release job at a time. */
export function runningReleaseJob(jobs: ReadonlyArray<ReleaseJob>): ReleaseJob | null {
  return jobs.find((job) => job.state === "running") ?? null;
}
