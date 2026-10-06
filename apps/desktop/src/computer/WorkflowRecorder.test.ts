import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import { makeWorkflowRecorder, type WorkflowRecorder } from "./WorkflowRecorder.ts";
import { makeFakeHelperSpawner, type FakeHelperSpawner } from "./testing/FakeHelperSpawner.ts";

const decodeJson = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const withRecorder = <A, E>(
  body: (h: {
    recorder: WorkflowRecorder;
    fake: FakeHelperSpawner;
    fs: FileSystem.FileSystem;
    directory: string;
  }) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-workflow-test-" });
    const fake = yield* makeFakeHelperSpawner;
    const recorder = yield* makeWorkflowRecorder({
      helperPath: "/fixture/pathway-helper",
      directory,
      targetName: "Test Mac",
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.layer));
    return yield* body({ recorder, fake, fs, directory });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

describe("workflow recording lifecycle", () => {
  it.effect(
    "waits for native confirmation, does not duplicate a start, and isolates other threads",
    () =>
      withRecorder(({ recorder, fake }) =>
        Effect.gen(function* () {
          const first = yield* recorder.call("start", "thread-a");
          expect(first.phase).toBe("awaiting-confirmation");
          expect(first.targetName).toBe("Test Mac");
          expect(first.startedAt).toBeUndefined();
          expect(yield* recorder.call("start", "thread-a")).toEqual(first);
          expect(fake.spawned).toHaveLength(1);
          expect((yield* recorder.call("status", "thread-b")).phase).toBe("busy");
          for (const action of ["start", "stop"] as const) {
            expect(Exit.isFailure(yield* Effect.exit(recorder.call(action, "thread-b")))).toBe(
              true,
            );
          }
          // Another thread may still discard its own saved recording; the live one is untouched.
          expect((yield* recorder.call("cancel", "thread-b")).phase).toBe("busy");
          expect(yield* recorder.call("status", "thread-a")).toEqual(first);
          const helper = yield* fake.next;
          const cancel = yield* recorder.call("cancel", "thread-a").pipe(Effect.forkChild);
          yield* helper.awaitStdin("cancel");
          yield* helper.emit({ type: "workflow-ended", reason: "cancelled" });
          yield* helper.exit(0);
          expect((yield* Fiber.join(cancel)).phase).toBe("cancelled");
        }),
      ),
  );

  it.effect(
    "drains events before returning completed artifacts and preserves them on reconnect",
    () =>
      withRecorder(({ recorder, fake, fs, directory }) =>
        Effect.gen(function* () {
          yield* recorder.call("start", "thread-a");
          const helper = yield* fake.next;
          yield* helper.emit({ type: "workflow-started" });
          yield* helper.emit({
            type: "workflow-event",
            event: { sequence: 1, kind: "key", text: "example" },
          });
          const stop = yield* recorder.call("stop", "thread-a").pipe(Effect.forkChild);
          yield* helper.awaitStdin("stop");
          yield* helper.emit({
            type: "workflow-event",
            event: { sequence: 2, kind: "window", app: "Fixture" },
          });
          yield* helper.emit({ type: "workflow-ended", reason: "stopped" });
          yield* helper.exit(0);
          const completed = yield* Fiber.join(stop);
          expect(completed.phase).toBe("completed");
          expect(completed.eventCount).toBe(2);
          expect(completed.eventsPath).toBeDefined();
          expect(
            (yield* fs.readFileString(completed.eventsPath!))
              .trim()
              .split("\n")
              .map((line) => decodeJson(line)),
          ).toEqual([
            { sequence: 1, kind: "key", text: "example" },
            { sequence: 2, kind: "window", app: "Fixture" },
          ]);
          const metadata = decodeJson(yield* fs.readFileString(completed.metadataPath!));
          expect(metadata.threadId).toBe("thread-a");
          expect(metadata.schemaVersion).toBe(1);
          expect(yield* recorder.call("status", "thread-a")).toEqual(completed);
          const restarted = yield* makeWorkflowRecorder({
            helperPath: "/fixture/pathway-helper",
            directory,
            targetName: "Test Mac",
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.layer),
            Effect.provide(NodeServices.layer),
          );
          expect(yield* restarted.call("status", "thread-a")).toEqual(completed);
          expect((yield* restarted.call("status", "thread-b")).eventsPath).toBeUndefined();
          expect((yield* recorder.call("status", "thread-b")).eventsPath).toBeUndefined();
          expect(yield* recorder.call("stop", "thread-a")).toEqual(completed);
          expect((yield* recorder.call("cancel", "thread-b")).phase).toBe("idle");
          expect(yield* fs.exists(completed.eventsPath!)).toBe(true);
          expect((yield* recorder.call("cancel", "thread-a")).phase).toBe("idle");
          expect(yield* fs.exists(completed.eventsPath!)).toBe(false);
          expect((yield* recorder.call("status", "thread-a")).phase).toBe("idle");
        }),
      ),
  );

  it.effect("discards a saved recording while another thread is recording", () =>
    withRecorder(({ recorder, fake, fs }) =>
      Effect.gen(function* () {
        yield* recorder.call("start", "thread-b");
        const first = yield* fake.next;
        yield* first.emit({ type: "workflow-started" });
        const stop = yield* recorder.call("stop", "thread-b").pipe(Effect.forkChild);
        yield* first.awaitStdin("stop");
        yield* first.emit({ type: "workflow-ended", reason: "stopped" });
        yield* first.exit(0);
        const saved = yield* Fiber.join(stop);
        expect(saved.phase).toBe("completed");

        const live = yield* recorder.call("start", "thread-a");
        const second = yield* fake.next;
        expect((yield* recorder.call("cancel", "thread-b")).phase).toBe("busy");
        expect(yield* fs.exists(saved.eventsPath!)).toBe(false);
        expect(yield* recorder.call("status", "thread-a")).toEqual(live);

        const cancel = yield* recorder.call("cancel", "thread-a").pipe(Effect.forkChild);
        yield* second.awaitStdin("cancel");
        yield* second.emit({ type: "workflow-ended", reason: "cancelled" });
        yield* second.exit(0);
        yield* Fiber.join(cancel);
      }),
    ),
  );

  it.effect("a stop the helper is too busy to answer still keeps the recording", () =>
    withRecorder(({ recorder, fake, fs }) =>
      Effect.gen(function* () {
        yield* recorder.call("start", "thread-a");
        const helper = yield* fake.next;
        yield* helper.emit({ type: "workflow-started" });
        yield* helper.emit({ type: "workflow-event", event: { sequence: 1, kind: "key" } });
        const stop = yield* recorder.call("stop", "thread-a").pipe(Effect.forkChild);
        yield* helper.awaitStdin("stop");
        yield* TestClock.adjust("3 seconds");
        const completed = yield* Fiber.join(stop);
        expect(helper.signals).toContain("SIGTERM");
        expect(completed.phase).toBe("completed");
        expect(completed.eventCount).toBe(1);
        expect(yield* fs.exists(completed.eventsPath!)).toBe(true);
      }),
    ),
  );

  it.effect("cancel removes all captured data and publishes no artifact paths", () =>
    withRecorder(({ recorder, fake, fs, directory }) =>
      Effect.gen(function* () {
        yield* recorder.call("start", "thread-a");
        const helper = yield* fake.next;
        yield* helper.emit({ type: "workflow-started" });
        yield* helper.emit({ type: "workflow-event", event: { text: "discard this" } });
        const cancel = yield* recorder.call("cancel", "thread-a").pipe(Effect.forkChild);
        yield* helper.awaitStdin("cancel");
        yield* helper.emit({ type: "workflow-ended", reason: "stopped" });
        yield* helper.exit(0);
        const result = yield* Fiber.join(cancel);
        expect(result.phase).toBe("cancelled");
        expect(result.eventsPath).toBeUndefined();
        expect(result.metadataPath).toBeUndefined();
        expect(yield* fs.readDirectory(directory)).toEqual([]);
      }),
    ),
  );

  it.effect("an unexpected helper exit fails the recording and removes partial evidence", () =>
    withRecorder(({ recorder, fake, fs, directory }) =>
      Effect.gen(function* () {
        yield* recorder.call("start", "thread-a");
        const helper = yield* fake.next;
        yield* helper.emit({ type: "workflow-started" });
        const stop = yield* recorder.call("stop", "thread-a").pipe(Effect.forkChild);
        yield* helper.awaitStdin("stop");
        yield* helper.exit(1);
        expect((yield* Fiber.join(stop)).phase).toBe("failed");
        expect(yield* fs.readDirectory(directory)).toEqual([]);
        expect((yield* recorder.call("start", "thread-b")).phase).toBe("awaiting-confirmation");
        const next = yield* fake.next;
        const cancel = yield* recorder.call("cancel", "thread-b").pipe(Effect.forkChild);
        yield* next.awaitStdin("cancel");
        yield* next.emit({ type: "workflow-ended", reason: "cancelled" });
        yield* next.exit(0);
        yield* Fiber.join(cancel);
      }),
    ),
  );

  it.effect("removes unfinished evidence left by host death", () =>
    withRecorder(({ fs, directory, fake }) =>
      Effect.gen(function* () {
        const orphan = `${directory}/recording-orphan`;
        yield* fs.makeDirectory(orphan);
        yield* fs.writeFileString(`${orphan}/events.jsonl`, "incomplete");
        yield* makeWorkflowRecorder({ helperPath: "/fixture/pathway-helper", directory }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fake.layer),
          Effect.provide(NodeServices.layer),
        );
        expect(yield* fs.exists(orphan)).toBe(false);
      }),
    ),
  );

  it.effect("spawn failure releases the recording slot and deletes the directory", () =>
    withRecorder(({ recorder, fake, fs, directory }) =>
      Effect.gen(function* () {
        fake.failNextSpawn();
        expect(Exit.isFailure(yield* Effect.exit(recorder.call("start", "thread-a")))).toBe(true);
        expect((yield* recorder.call("status", "thread-a")).phase).toBe("failed");
        expect(yield* fs.readDirectory(directory)).toEqual([]);
      }),
    ),
  );
});
