import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import { ChildProcessSpawner } from "effect/unstable/process";
import {
  idleWorkflowRecording,
  type WorkflowRecordingAction,
  WorkflowRecordingStatus,
} from "@spiritdevs/contracts";
import { spawnHelper, stopHelper, type HelperProcess } from "./HelperProcess.ts";

export class WorkflowRecordingError extends Schema.TaggedErrorClass<WorkflowRecordingError>()(
  "WorkflowRecordingError",
  { message: Schema.String },
) {}

const HelperEvent = Schema.fromJsonString(
  Schema.Union([
    Schema.Struct({ type: Schema.Literal("workflow-started") }),
    Schema.Struct({
      type: Schema.Literal("workflow-event"),
      event: Schema.Record(Schema.String, Schema.Unknown),
    }),
    Schema.Struct({
      type: Schema.Literal("workflow-ended"),
      reason: Schema.Literals(["stopped", "cancelled", "time-limit", "size-limit"]),
    }),
    Schema.Struct({ type: Schema.Literal("error"), message: Schema.String }),
  ]),
);
const decodeEvent = Schema.decodeUnknownOption(HelperEvent);
const decodeStored = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      ...WorkflowRecordingStatus.fields,
      threadId: Schema.String,
      schemaVersion: Schema.Literal(1),
    }),
  ),
);
const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const MAX_BYTES = 32 * 1024 * 1024;

interface Recording {
  readonly threadId: string;
  readonly directory: string;
  readonly targetName?: string;
  readonly eventsPath: string;
  readonly metadataPath: string;
  readonly ended: Deferred.Deferred<void>;
  status: WorkflowRecordingStatus;
  helper?: HelperProcess;
  bytes: number;
  terminalReason?: string;
}

export interface WorkflowRecorder {
  readonly cancelActive?: Effect.Effect<void, WorkflowRecordingError>;
  readonly call: (
    action: WorkflowRecordingAction,
    threadId: string,
  ) => Effect.Effect<WorkflowRecordingStatus, WorkflowRecordingError>;
}

/** One recording per desktop. Native confirmation and controls own capture consent. */
export const makeWorkflowRecorder = Effect.fn("desktop.makeWorkflowRecorder")(function* (options: {
  readonly helperPath: string;
  readonly directory: string;
  readonly targetName?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const scope = yield* Scope.Scope;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // A dead host cannot run its finalizers. Drop unfinished evidence on its next launch.
  const existing = yield* fs
    .readDirectory(options.directory)
    .pipe(Effect.orElseSucceed(() => [] as string[]));
  yield* Effect.forEach(
    existing.filter((name) => /^recording-[a-zA-Z0-9]+$/.test(name)),
    (name) =>
      Effect.gen(function* () {
        const directory = path.join(options.directory, name);
        const contents = yield* fs
          .readFileString(path.join(directory, "session.json"))
          .pipe(Effect.orElseSucceed(() => undefined));
        const decoded = contents ? decodeStored(contents) : Option.none();
        if (Option.isNone(decoded) || decoded.value.phase !== "completed")
          yield* fs.remove(directory, { recursive: true, force: true });
      }),
    { concurrency: 4, discard: true },
  );
  const lock = yield* Semaphore.make(1);
  const latest = new Map<string, WorkflowRecordingStatus>();
  let active: Recording | undefined;
  const error = (message: string) => new WorkflowRecordingError({ message });
  const remember = (recording: Recording) => {
    latest.delete(recording.threadId);
    latest.set(recording.threadId, recording.status);
    while (latest.size > 32) latest.delete(latest.keys().next().value!);
  };

  const restoreCompleted = Effect.fn("workflowRecording.restoreCompleted")(function* (
    threadId: string,
  ) {
    const names = yield* fs
      .readDirectory(options.directory)
      .pipe(Effect.orElseSucceed(() => [] as string[]));
    let restored: WorkflowRecordingStatus | undefined;
    for (const name of names) {
      if (!/^recording-[a-zA-Z0-9]+$/.test(name)) continue;
      const metadataPath = path.join(options.directory, name, "session.json");
      const contents = yield* fs
        .readFileString(metadataPath)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (!contents) continue;
      const decoded = decodeStored(contents);
      if (
        Option.isNone(decoded) ||
        decoded.value.threadId !== threadId ||
        decoded.value.phase !== "completed"
      )
        continue;
      const eventsPath = path.join(options.directory, name, "events.jsonl");
      if (!(yield* fs.exists(eventsPath))) continue;
      const { threadId: _owner, schemaVersion: _version, ...status } = decoded.value;
      if (!restored || (status.endedAt ?? "") > (restored.endedAt ?? ""))
        restored = { ...status, eventsPath, metadataPath };
    }
    if (restored) latest.set(threadId, restored);
    return restored;
  });

  const finalize = Effect.fn("workflowRecording.finalize")(function* (recording: Recording) {
    const reported = recording.terminalReason ?? "helper-exited";
    const reason = reported === "stopped" && !recording.status.startedAt ? "cancelled" : reported;
    const completed = reason === "stopped" || reason === "time-limit" || reason === "size-limit";
    recording.status = {
      ...recording.status,
      phase: completed ? "completed" : reason === "cancelled" ? "cancelled" : "failed",
      endedAt: DateTime.formatIso(yield* DateTime.now),
      endReason: reason,
      ...(completed
        ? { eventsPath: recording.eventsPath, metadataPath: recording.metadataPath }
        : {}),
    };
    if (completed) {
      yield* fs.writeFileString(
        recording.metadataPath,
        encode({
          ...recording.status,
          threadId: recording.threadId,
          schemaVersion: 1,
        }),
        { mode: 0o600 },
      );
    } else {
      yield* fs.remove(recording.directory, { recursive: true, force: true });
    }
    remember(recording);
    if (active === recording) active = undefined;
  });

  const finish = Effect.fn("workflowRecording.finish")(function* (
    recording: Recording,
    action: "stop" | "cancel",
  ) {
    if (action === "cancel") recording.terminalReason = "cancelled";
    recording.status = { ...recording.status, phase: "stopping" };
    const helper = recording.helper;
    if (helper) {
      yield* helper.writeLine(action);
      if (Option.isNone(yield* Effect.timeoutOption(Deferred.await(recording.ended), 3_000))) {
        yield* stopHelper(helper);
        yield* Deferred.await(recording.ended);
      }
    }
    return recording.status;
  });

  const start = Effect.fn("workflowRecording.start")(function* (threadId: string) {
    yield* fs.makeDirectory(options.directory, { recursive: true });
    yield* fs.chmod(options.directory, 0o700);
    const directory = yield* fs.makeTempDirectory({
      directory: options.directory,
      prefix: "recording-",
    });
    const recording: Recording = {
      threadId,
      directory,
      eventsPath: path.join(directory, "events.jsonl"),
      metadataPath: path.join(directory, "session.json"),
      ended: yield* Deferred.make<void>(),
      bytes: 0,
      status: {
        ...idleWorkflowRecording(true),
        ...(options.targetName ? { targetName: options.targetName } : {}),
        phase: "awaiting-confirmation",
        recordingId: path.basename(directory),
      },
    };
    active = recording;
    recording.helper = yield* fs.writeFileString(recording.eventsPath, "", { mode: 0o600 }).pipe(
      Effect.andThen(
        spawnHelper(scope, {
          command: options.helperPath,
          args: [
            "--record-workflow",
            ...(options.targetName ? ["--target-name", options.targetName] : []),
          ],
          stdin: true,
          onStdoutLine: (line) =>
            Effect.gen(function* () {
              const decoded = decodeEvent(line);
              if (Option.isNone(decoded)) return;
              const event = decoded.value;
              if (event.type === "workflow-started") {
                recording.status = {
                  ...recording.status,
                  phase: "recording",
                  startedAt: DateTime.formatIso(yield* DateTime.now),
                };
              } else if (event.type === "workflow-ended") {
                recording.terminalReason ??= event.reason;
              } else if (event.type === "error") {
                recording.terminalReason = "capture-error";
                recording.status = { ...recording.status, message: event.message };
              } else if (recording.status.startedAt && !recording.terminalReason) {
                const data = `${encode(event.event)}\n`;
                recording.bytes += new TextEncoder().encode(data).length;
                if (recording.bytes > MAX_BYTES) {
                  recording.terminalReason = "size-limit";
                  yield* recording.helper?.writeLine("stop") ?? Effect.void;
                } else {
                  yield* fs.writeFileString(recording.eventsPath, data, { flag: "a" });
                  recording.status = {
                    ...recording.status,
                    eventCount: recording.status.eventCount + 1,
                  };
                }
              }
            }).pipe(
              Effect.catch(() =>
                Effect.gen(function* () {
                  recording.terminalReason = "write-failed";
                  yield* recording.helper?.writeLine("cancel") ?? Effect.void;
                }),
              ),
            ),
          onExit: () =>
            finalize(recording).pipe(
              Effect.catch(() =>
                fs.remove(recording.directory, { recursive: true, force: true }).pipe(
                  Effect.ignore,
                  Effect.andThen(
                    Effect.sync(() => {
                      recording.status = {
                        ...idleWorkflowRecording(true),
                        phase: "failed",
                        message: "Could not save the recording.",
                      };
                      remember(recording);
                      if (active === recording) active = undefined;
                    }),
                  ),
                ),
              ),
              Effect.ensuring(Deferred.succeed(recording.ended, undefined)),
            ),
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)),
      ),
      Effect.onError(() =>
        Effect.gen(function* () {
          recording.terminalReason = "start-failed";
          yield* finalize(recording);
        }).pipe(Effect.ignore),
      ),
    );
    return recording.status;
  });

  const cancelActive = lock.withPermit(
    Effect.suspend(() =>
      active
        ? finish(active, "cancel").pipe(
            Effect.asVoid,
            Effect.mapError((cause) => error(cause.message)),
          )
        : Effect.void,
    ),
  );
  yield* Effect.addFinalizer(() => cancelActive.pipe(Effect.ignore));

  const call: WorkflowRecorder["call"] = (action, threadId) =>
    lock.withPermit(
      Effect.gen(function* () {
        if (active && active.threadId !== threadId) {
          if (action === "status")
            return {
              ...idleWorkflowRecording(true),
              ...(options.targetName ? { targetName: options.targetName } : {}),
              phase: "busy" as const,
            };
          return yield* error(
            "Another thread is recording on this Mac. Stop or cancel it from that thread first.",
          );
        }
        if (active) {
          if (action === "start" || action === "status") return active.status;
          return yield* finish(active, action);
        }
        const previous = latest.get(threadId) ?? (yield* restoreCompleted(threadId));
        if (action === "start" || action === "cancel") {
          if (previous?.metadataPath)
            yield* fs.remove(path.dirname(previous.metadataPath), { recursive: true, force: true });
          latest.delete(threadId);
          if (action === "start") return yield* start(threadId);
          return {
            ...idleWorkflowRecording(true),
            ...(options.targetName ? { targetName: options.targetName } : {}),
          };
        }
        return (
          previous ?? {
            ...idleWorkflowRecording(true),
            ...(options.targetName ? { targetName: options.targetName } : {}),
          }
        );
      }).pipe(Effect.mapError((cause) => error(cause.message))),
    );
  return { call, cancelActive } satisfies WorkflowRecorder;
});
