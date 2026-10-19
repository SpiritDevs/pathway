import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type VcsStatusStreamEvent,
} from "@spiritdevs/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { VcsStatusBroadcaster } from "../vcs/VcsStatusBroadcaster.ts";
import { ThreadManagementService } from "./ThreadManagementService.ts";
import { temporaryPullRequestWatch, watchTemporaryThreads } from "./TemporaryThreadSettlement.ts";

const threadId = ThreadId.make("temporary-pr-observer");
const pullRequest = { number: 42, url: "https://github.com/example/repo/pull/42" };
const shell = {
  id: threadId,
  temporary: true,
  deletedAt: null,
  archivedAt: null,
  worktreePath: "/tmp/temporary-pr-worktree",
  attachedPullRequest: pullRequest,
} as OrchestrationV2ThreadShell;
const remote = {
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: { ...pullRequest, title: "Work", baseRef: "main", headRef: "work", state: "merged" as const },
};

it.effect("observes merged PRs from the initial server snapshot without a connected client", () =>
  Effect.gen(function* () {
    const dispatched = yield* Deferred.make<OrchestrationV2Command>();
    const requestedBackground = yield* Ref.make(false);
    const threads = {
      streamDomainEvents: Stream.never,
      getShellSnapshot: () =>
        Effect.succeed({ threads: [shell], archivedThreads: [], snapshotSequence: 0 }),
      getThreadShell: () => Effect.succeed(shell),
      dispatch: (command: OrchestrationV2Command) =>
        Deferred.succeed(dispatched, command).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
    } as ThreadManagementService["Service"];
    const vcs = {
      streamStatus: (_input, options) =>
        Stream.unwrap(
          Ref.set(requestedBackground, options?.runInBackground === true).pipe(
            Effect.as(
              Stream.concat(Stream.make({ _tag: "remoteUpdated" as const, remote }), Stream.never),
            ),
          ),
        ),
    } as VcsStatusBroadcaster["Service"];
    yield* watchTemporaryThreads().pipe(
      Effect.provideService(ThreadManagementService, threads),
      Effect.provideService(VcsStatusBroadcaster, vcs),
      Effect.forkScoped,
    );
    const command = yield* Deferred.await(dispatched);
    assert.equal(command.type, "thread.settle");
    if (command.type === "thread.settle") assert.isTrue(command.automatic);
    assert.isTrue(yield* Ref.get(requestedBackground));
  }),
);

it.effect("releases the background PR subscription when Keep makes the thread permanent", () =>
  Effect.gen(function* () {
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const vcsEvents = yield* Queue.unbounded<VcsStatusStreamEvent>();
    const subscribed = yield* Deferred.make<void>();
    const released = yield* Deferred.make<void>();
    const dispatchCount = yield* Ref.make(0);
    let current = shell;
    const threads = {
      streamDomainEvents: Stream.fromQueue(events),
      getShellSnapshot: () =>
        Effect.succeed({ threads: [shell], archivedThreads: [], snapshotSequence: 0 }),
      getThreadShell: () => Effect.sync(() => current),
      dispatch: () =>
        Ref.update(dispatchCount, (count) => count + 1).pipe(
          Effect.as({ sequence: 1, storedEvents: [] }),
        ),
    } as ThreadManagementService["Service"];
    const vcs = {
      streamStatus: () =>
        Stream.unwrap(
          Deferred.succeed(subscribed, undefined).pipe(
            Effect.as(
              Stream.fromQueue(vcsEvents).pipe(
                Stream.ensuring(Deferred.succeed(released, undefined)),
              ),
            ),
          ),
        ),
    } as VcsStatusBroadcaster["Service"];
    yield* watchTemporaryThreads().pipe(
      Effect.provideService(ThreadManagementService, threads),
      Effect.provideService(VcsStatusBroadcaster, vcs),
      Effect.forkScoped,
    );
    yield* Deferred.await(subscribed);
    current = { ...shell, temporary: false };
    yield* Queue.offer(events, {
      type: "thread.metadata-updated",
      threadId,
      payload: current,
    } as OrchestrationV2DomainEvent);
    yield* Deferred.await(released);
    assert.equal(yield* Ref.get(dispatchCount), 0);
  }),
);

it("only watches temporary threads with an attached PR and an owned workspace", () => {
  assert.deepEqual(temporaryPullRequestWatch(shell), { cwd: shell.worktreePath, pullRequest });
  assert.isNull(temporaryPullRequestWatch({ ...shell, temporary: false }));
  assert.isNull(temporaryPullRequestWatch({ ...shell, attachedPullRequest: null }));
  assert.isNull(temporaryPullRequestWatch({ ...shell, worktreePath: null }));
});
