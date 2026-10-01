import type { DeviceSummary, EnvironmentId, ProjectId, ThreadId } from "@spiritdevs/contracts";
import type {
  SimBuildAction,
  SimBuildDiscovery,
  SimBuildFailure,
  SimBuildJob,
  SimBuildLogChunk,
} from "@spiritdevs/contracts/simBuild";
import { squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { CircleAlertIcon, PlayIcon, TriangleAlertIcon, X } from "lucide-react";
import { memo, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from "react";

import { useOpenInPreferredEditor } from "~/editorPreferences";
import { cn, randomUUID } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { simBuildEnvironment } from "~/state/simBuild";
import { useAtomCommand } from "~/state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import {
  currentSimBuildJob,
  defaultSimBuildSelection,
  SIM_BUILD_ACTION_LABELS,
  SIM_BUILD_PHASE_LABELS,
  simBuildBlocker,
  simBuildContainerInventory,
  simBuildDiagnosticLocation,
  simBuildDiagnostics,
  simBuildDiagnosticTarget,
  simBuildFailure,
  simBuildJobTitle,
  simBuildSteps,
  type SimBuildSelection,
} from "./simBuild.logic";

const DEFAULT_OPTION = "\u0000default";

type CommandFailure = { readonly message: string; readonly code: SimBuildFailure["code"] | null };

const describeFailure = (cause: unknown, fallback: string): CommandFailure => {
  const failure = simBuildFailure(cause);
  return failure ?? { code: null, message: fallback };
};

/**
 * Builds the thread's checkout onto the simulator showing in the Devices panel. Everything runs on
 * the project's environment, so the same bar works over local, relay and tunnel connections.
 */
export function SimBuildBar(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId | null;
  readonly device: DeviceSummary;
  readonly hostSupport: "mac" | "not-mac" | "unknown";
  readonly visible: boolean;
  /** Bumped by the "Run on simulator" palette command to open the form. */
  readonly openRequest: number;
}) {
  const { environmentId, threadId, projectId, device } = props;
  const discover = useAtomCommand(simBuildEnvironment.discover, { reportFailure: false });
  const start = useAtomCommand(simBuildEnvironment.start, { reportFailure: false });
  const list = useAtomCommand(simBuildEnvironment.list, { reportFailure: false });
  const blocker = simBuildBlocker({ device, hostSupport: props.hostSupport, projectId });
  const [formOpen, setFormOpen] = useState(false);
  const [discovery, setDiscovery] = useState<SimBuildDiscovery | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const [discoverError, setDiscoverError] = useState<CommandFailure | null>(null);
  const [selection, setSelection] = useState<SimBuildSelection | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<CommandFailure | null>(null);
  const [job, setJob] = useState<SimBuildJob | null>(null);

  // Restore the thread's latest job; a build started from another client or an agent shows here too.
  useEffect(() => {
    if (!props.visible || projectId === null) return;
    let cancelled = false;
    void list({ environmentId, input: { environmentId, projectId, threadId } }).then((result) => {
      if (cancelled || result._tag === "Failure") return;
      const latest = currentSimBuildJob(result.value);
      if (latest) setJob((current) => current ?? latest);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, list, projectId, props.visible, threadId]);

  const runDiscovery = async () => {
    if (projectId === null) return;
    setDiscovering(true);
    setDiscoverError(null);
    const result = await discover({ environmentId, input: { environmentId, projectId, threadId } });
    setDiscovering(false);
    if (result._tag === "Failure") {
      setDiscoverError(
        describeFailure(
          squashAtomCommandFailure(result),
          "Could not read this project's Xcode schemes.",
        ),
      );
      return;
    }
    setDiscovery(result.value);
    setSelection((previous) => defaultSimBuildSelection(result.value, previous));
  };

  const openForm = () => {
    setFormOpen(true);
    setStartError(null);
    if (discovery === null && !discovering) void runDiscovery();
  };

  const handledRequest = useRef(0);
  const openFormOnRequest = useEffectEvent(() => {
    if (!blocker) openForm();
  });
  useEffect(() => {
    if (props.openRequest === handledRequest.current) return;
    handledRequest.current = props.openRequest;
    openFormOnRequest();
  }, [props.openRequest]);

  const startJob = async (input: {
    readonly action: SimBuildAction;
    readonly containerPath: string;
    readonly scheme: string;
    readonly configuration?: string | null | undefined;
    readonly target?: string | null | undefined;
  }) => {
    if (projectId === null) return;
    setStarting(true);
    setStartError(null);
    const result = await start({
      environmentId,
      input: {
        environmentId,
        projectId,
        threadId,
        hostId: device.hostId,
        deviceId: device.id,
        action: input.action,
        containerPath: input.containerPath,
        scheme: input.scheme,
        ...(input.configuration ? { configuration: input.configuration } : {}),
        ...(input.target ? { target: input.target } : {}),
        requestId: randomUUID(),
      },
    });
    setStarting(false);
    if (result._tag === "Failure") {
      setStartError(
        describeFailure(squashAtomCommandFailure(result), "Could not start the simulator build."),
      );
      return;
    }
    setJob(result.value);
    setFormOpen(false);
  };

  if (device.platform !== "ios") return null;

  return (
    <section
      aria-label="Simulator builds"
      className="max-h-[55%] shrink-0 overflow-y-auto border-t"
    >
      <div className="flex flex-wrap items-center gap-2 px-3 py-2">
        <Button
          size="xs"
          variant={formOpen ? "secondary" : "outline"}
          disabled={blocker !== null}
          onClick={() => (formOpen ? setFormOpen(false) : openForm())}
        >
          <PlayIcon className="size-3" />
          Run on {device.name}…
        </Button>
        {blocker ? <p className="text-xs text-muted-foreground">{blocker}</p> : null}
      </div>
      {formOpen && !blocker ? (
        <SimBuildForm
          discovery={discovery}
          discovering={discovering}
          discoverError={discoverError}
          selection={selection}
          starting={starting}
          startError={startError}
          onSelection={setSelection}
          onRefresh={() => void runDiscovery()}
          onStart={(value) => void startJob(value)}
          onClose={() => setFormOpen(false)}
        />
      ) : null}
      {job && projectId !== null ? (
        <SimBuildJobCard
          key={job.id}
          environmentId={environmentId}
          projectId={projectId}
          threadId={threadId}
          initialJob={job}
          deviceName={device.id === job.deviceId ? device.name : "another simulator"}
          visible={props.visible}
          starting={starting}
          onRunAgain={(previous) => void startJob(previous)}
          onChangeSettings={openForm}
          onDismiss={() => setJob(null)}
        />
      ) : null}
    </section>
  );
}

function SimBuildForm(props: {
  readonly discovery: SimBuildDiscovery | null;
  readonly discovering: boolean;
  readonly discoverError: CommandFailure | null;
  readonly selection: SimBuildSelection | null;
  readonly starting: boolean;
  readonly startError: CommandFailure | null;
  readonly onSelection: (selection: SimBuildSelection) => void;
  readonly onRefresh: () => void;
  readonly onStart: (selection: SimBuildSelection) => void;
  readonly onClose: () => void;
}) {
  const { discovery, selection } = props;
  const containers = discovery?.containers ?? [];
  const container = containers.find((candidate) => candidate.path === selection?.containerPath);
  const inventory = selection
    ? simBuildContainerInventory(containers, selection.containerPath)
    : { targets: [], configurations: [] };
  const update = (patch: Partial<SimBuildSelection>) => {
    if (selection) props.onSelection({ ...selection, ...patch });
  };
  return (
    <div className="mx-3 mb-3 space-y-3 rounded-md border p-3 text-xs">
      {props.discovering && !discovery ? (
        <p className="flex items-center gap-2 text-muted-foreground">
          <Spinner className="size-3" /> Reading Xcode schemes…
        </p>
      ) : null}
      {props.discoverError ? <SimBuildFailureNotice failure={props.discoverError} /> : null}
      {discovery?.notices.map((notice) => (
        <p key={notice} role="note" className="text-muted-foreground">
          {notice}
        </p>
      ))}
      {discovery && selection && container ? (
        <>
          <div className="flex flex-wrap gap-2">
            {containers.length > 1 ? (
              <Select
                value={selection.containerPath}
                onValueChange={(value) => {
                  const next = containers.find((candidate) => candidate.path === value);
                  if (next?.schemes[0])
                    update({
                      containerPath: next.path,
                      scheme: next.schemes[0],
                      configuration: null,
                      target: null,
                    });
                }}
              >
                <SelectTrigger size="sm" aria-label="Project or workspace" className="w-auto">
                  <SelectValue>{selection.containerPath}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {containers
                    .filter((candidate) => candidate.schemes.length > 0)
                    .map((candidate) => (
                      <SelectItem key={candidate.path} value={candidate.path}>
                        {candidate.path}
                      </SelectItem>
                    ))}
                </SelectPopup>
              </Select>
            ) : (
              <span className="self-center text-muted-foreground">{selection.containerPath}</span>
            )}
            <Select
              value={selection.scheme}
              onValueChange={(value) => {
                if (value !== null) update({ scheme: value, target: null });
              }}
            >
              <SelectTrigger size="sm" aria-label="Scheme" className="w-auto">
                <SelectValue>{selection.scheme}</SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {container.schemes.map((scheme) => (
                  <SelectItem key={scheme} value={scheme}>
                    {scheme}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {inventory.configurations.length > 0 ? (
              <Select
                value={selection.configuration ?? DEFAULT_OPTION}
                onValueChange={(value) =>
                  update({ configuration: value === DEFAULT_OPTION ? null : value })
                }
              >
                <SelectTrigger size="sm" aria-label="Configuration" className="w-auto">
                  <SelectValue>{selection.configuration ?? "Default configuration"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={DEFAULT_OPTION}>Default configuration</SelectItem>
                  {inventory.configurations.map((configuration) => (
                    <SelectItem key={configuration} value={configuration}>
                      {configuration}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
            {inventory.targets.length > 1 && selection.action !== "test" ? (
              <Select
                value={selection.target ?? DEFAULT_OPTION}
                onValueChange={(value) =>
                  update({ target: value === DEFAULT_OPTION ? null : value })
                }
              >
                <SelectTrigger size="sm" aria-label="App target" className="w-auto">
                  <SelectValue>{selection.target ?? "Scheme's app"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  <SelectItem value={DEFAULT_OPTION}>Scheme's app</SelectItem>
                  {inventory.targets.map((target) => (
                    <SelectItem key={target} value={target}>
                      {target}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <ToggleGroup
              size="sm"
              aria-label="Action"
              value={[selection.action]}
              onValueChange={(value) => {
                const next = value[0];
                if (next === "build" || next === "run" || next === "test") update({ action: next });
              }}
            >
              {(["run", "build", "test"] as const).map((action) => (
                <Toggle key={action} value={action} variant="outline">
                  {SIM_BUILD_ACTION_LABELS[action]}
                </Toggle>
              ))}
            </ToggleGroup>
            <Button size="xs" disabled={props.starting} onClick={() => props.onStart(selection)}>
              {props.starting ? <Spinner className="size-3" /> : null}
              {SIM_BUILD_ACTION_LABELS[selection.action]}
            </Button>
          </div>
        </>
      ) : null}
      {discovery && !selection && !props.discovering ? (
        <p className="text-muted-foreground">
          No buildable scheme was found. Open the project in Xcode once to create shared schemes,
          then refresh.
        </p>
      ) : null}
      {props.startError ? <SimBuildFailureNotice failure={props.startError} /> : null}
      <div className="flex gap-2">
        <Button size="xs" variant="ghost" disabled={props.discovering} onClick={props.onRefresh}>
          Refresh schemes
        </Button>
        <Button size="xs" variant="ghost" onClick={props.onClose}>
          Close
        </Button>
      </div>
    </div>
  );
}

/** Unsupported hosts and missing Xcode get their own copy; everything else shows the server text. */
function SimBuildFailureNotice({ failure }: { readonly failure: CommandFailure }) {
  return (
    <div role="alert" className="space-y-2 text-destructive">
      <p>
        {failure.code === "needs-mac"
          ? "Simulator builds need this project's environment to run on a Mac."
          : failure.message}
      </p>
      {failure.code === "unavailable" ? (
        <Button size="xs" variant="outline" render={<Link to="/settings/xcode" />}>
          Open Xcode setup
        </Button>
      ) : null}
    </div>
  );
}

function SimBuildJobCard(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly initialJob: SimBuildJob;
  readonly deviceName: string;
  readonly visible: boolean;
  readonly starting: boolean;
  readonly onRunAgain: (job: SimBuildJob) => void;
  readonly onChangeSettings: () => void;
  readonly onDismiss: () => void;
}) {
  const { environmentId, projectId, threadId } = props;
  const input = { environmentId, projectId, threadId, jobId: props.initialJob.id };
  // Mounted only while visible; hiding releases the stream without cancelling the build.
  const view = useEnvironmentQuery(
    props.visible ? simBuildEnvironment.view({ environmentId, input }) : null,
  ).data;
  const cancel = useAtomCommand(simBuildEnvironment.cancel, { reportFailure: false });
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelledJob, setCancelledJob] = useState<SimBuildJob | null>(null);
  const job = view?.job ?? cancelledJob ?? props.initialJob;
  const logs = view?.logs ?? [];
  const diagnostics = simBuildDiagnostics(logs);
  const steps = simBuildSteps(job.action);
  const reached = job.terminal
    ? new Set(view?.receipts.map((receipt) => receipt.job.phase) ?? [])
    : null;
  const currentIndex = steps.indexOf(job.phase);

  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const openInEditor = useOpenInPreferredEditor(
    environmentId,
    serverConfig?.availableEditors ?? [],
  );
  const [openError, setOpenError] = useState<string | null>(null);

  const requestCancel = async () => {
    setCancelling(true);
    setCancelError(null);
    const result = await cancel({ environmentId, input });
    setCancelling(false);
    if (result._tag === "Failure")
      setCancelError(
        describeFailure(squashAtomCommandFailure(result), "Could not cancel the build.").message,
      );
    else setCancelledJob(result.value);
  };

  return (
    <div className="mx-3 mb-3 space-y-2 rounded-md border p-3 text-xs" aria-label="Build job">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 truncate text-sm font-medium">
          {simBuildJobTitle(job, props.deviceName)}
        </p>
        <Badge
          size="sm"
          variant={
            job.phase === "failed"
              ? "error"
              : job.phase === "running" || job.phase === "completed"
                ? "success"
                : "outline"
          }
        >
          {job.terminal ? null : <Spinner className="size-2.5" />}
          {SIM_BUILD_PHASE_LABELS[job.phase]}
        </Badge>
        {job.terminal ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss build"
            onClick={props.onDismiss}
          >
            <X className="size-3" />
          </Button>
        ) : null}
      </div>
      <ol aria-label="Phases" className="flex flex-wrap gap-x-3 gap-y-1">
        {steps.map((step, index) => {
          const done = reached ? reached.has(step) : currentIndex > index;
          const current = step === job.phase;
          return (
            <li
              key={step}
              aria-current={current ? "step" : undefined}
              className={cn(
                current ? "font-medium text-foreground" : done ? "text-foreground" : "",
                !current && !done && "text-muted-foreground",
              )}
            >
              {SIM_BUILD_PHASE_LABELS[step]}
            </li>
          );
        })}
      </ol>
      {job.failure && job.phase !== "cancelled" ? (
        <p role="alert" className="text-destructive">
          {job.failure.message}
        </p>
      ) : null}
      {job.phase === "running" ? (
        <p className="text-muted-foreground">
          Launched {job.artifact?.bundleId ?? "the app"}. Pathway doesn't watch it after launch.
        </p>
      ) : null}
      {diagnostics.items.length > 0 ? (
        <div className="space-y-1">
          <p className="text-muted-foreground">
            {diagnostics.errors} {diagnostics.errors === 1 ? "error" : "errors"},{" "}
            {diagnostics.warnings} {diagnostics.warnings === 1 ? "warning" : "warnings"}
          </p>
          <ul aria-label="Diagnostics" className="space-y-1">
            {diagnostics.items.map((diagnostic) => {
              const target = simBuildDiagnosticTarget(diagnostic);
              const location = simBuildDiagnosticLocation(diagnostic, job.workspaceRoot);
              return (
                <li key={diagnostic.key} className="flex items-start gap-1.5">
                  {diagnostic.severity === "error" ? (
                    <CircleAlertIcon className="mt-px size-3 shrink-0 text-destructive" />
                  ) : (
                    <TriangleAlertIcon className="mt-px size-3 shrink-0 text-warning" />
                  )}
                  <span className="min-w-0 break-words">
                    {target && location ? (
                      <button
                        type="button"
                        className="mr-1 font-mono text-foreground underline-offset-2 hover:underline"
                        onClick={() =>
                          void openInEditor(target).then((result) =>
                            setOpenError(
                              result._tag === "Failure"
                                ? `Could not open ${location} in an editor.`
                                : null,
                            ),
                          )
                        }
                      >
                        {location}
                      </button>
                    ) : null}
                    {diagnostic.message}
                  </span>
                </li>
              );
            })}
          </ul>
          {openError ? <p className="text-destructive">{openError}</p> : null}
        </div>
      ) : null}
      {view?.logsTruncated ? (
        <p role="note" className="text-muted-foreground">
          Earlier output was trimmed. Showing the most recent build output.
        </p>
      ) : null}
      {logs.length > 0 ? <SimBuildLog logs={logs} /> : null}
      {cancelError ? <p className="text-destructive">{cancelError}</p> : null}
      <div className="flex flex-wrap gap-2">
        {job.terminal ? (
          <>
            <Button size="xs" disabled={props.starting} onClick={() => props.onRunAgain(job)}>
              {SIM_BUILD_ACTION_LABELS[job.action]} again
            </Button>
            <Button size="xs" variant="ghost" onClick={props.onChangeSettings}>
              Change settings
            </Button>
          </>
        ) : (
          <Button
            size="xs"
            variant="outline"
            disabled={cancelling}
            onClick={() => void requestCancel()}
          >
            {cancelling ? <Spinner className="size-3" /> : null}
            {cancelling ? "Cancelling…" : "Cancel"}
          </Button>
        )}
      </div>
    </div>
  );
}

/**
 * The bounded log tail. Chunks keep their identity across updates, so a new batch renders only
 * itself; the view sticks to the bottom unless the user has scrolled up.
 */
function SimBuildLog({ logs }: { readonly logs: readonly SimBuildLogChunk[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const pinned = useRef(true);
  const last = logs.at(-1)?.sequence;
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  }, [last]);
  return (
    <pre
      ref={ref}
      aria-label="Build log"
      tabIndex={0}
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 16;
      }}
      className="max-h-48 overflow-auto rounded border bg-muted/40 p-2 font-mono text-[11px] leading-4 whitespace-pre-wrap break-all"
    >
      {logs.map((chunk) => (
        <SimBuildLogChunkText key={chunk.sequence} chunk={chunk} />
      ))}
    </pre>
  );
}

const SimBuildLogChunkText = memo(function SimBuildLogChunkText({
  chunk,
}: {
  readonly chunk: SimBuildLogChunk;
}) {
  return <span>{chunk.text}</span>;
});
