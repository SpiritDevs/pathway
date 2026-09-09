import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointScopeId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type VcsStatusResult,
} from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as CheckpointCapture from "./CheckpointCaptureService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { EventSinkV2 } from "./EventSink.ts";
import * as RunFinalization from "./RunFinalizationService.ts";

const vcsStatus = {
  isRepo: true,
  sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
  hasPrimaryRemote: true,
  isDefaultRef: false,
  refName: "feature/issues-pr",
  hasWorkingTreeChanges: false,
  workingTree: { files: [], insertions: 0, deletions: 0 },
  hasUpstream: true,
  aheadCount: 0,
  behindCount: 0,
  pr: {
    number: 42,
    title: "Show PRs on issues",
    url: "https://github.com/SpiritDevs/pathway/pull/42",
    baseRef: "main",
    headRef: "feature/issues-pr",
    state: "open",
  },
} satisfies VcsStatusResult;

it("maps refreshed VCS status to issue PR metadata", () => {
  const threadId = ThreadId.make("thread-pr");
  assert.deepStrictEqual(RunFinalization.issuePullRequestFromStatus(threadId, vcsStatus), {
    threadId,
    provider: "github",
    number: 42,
    title: "Show PRs on issues",
    url: "https://github.com/SpiritDevs/pathway/pull/42",
    state: "open",
  });
  assert.isNull(RunFinalization.issuePullRequestFromStatus(threadId, { ...vcsStatus, pr: null }));
});

it.effect("captures the root checkpoint and refreshes workspace state", () => {
  const threadId = ThreadId.make("thread_finalize");
  const runId = RunId.make("run_finalize");
  const scopeId = CheckpointScopeId.make("scope_finalize");
  const capture = vi.fn(() => Effect.void);
  const refresh = vi.fn(() => Effect.void);
  const projection = {
    checkpointScopes: [{ id: scopeId, cwd: "/repo" }],
    turnItems: [],
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(EventSinkV2)({}),
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({ execute: capture }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, { refresh }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId, scopeId });
    assert.equal(capture.mock.calls.length, 1);
    assert.deepEqual(refresh.mock.calls[0], [threadId, "/repo"]);
  }).pipe(Effect.provide(layer));
});

it.effect("records every discovered PR once and respects previous unlink markers", () => {
  const threadId = ThreadId.make("thread_discover");
  const runId = RunId.make("run_discover");
  const scopeId = CheckpointScopeId.make("scope_discover");
  let projection = {
    checkpointScopes: [{ id: scopeId, cwd: "/repo" }],
    turnItems: [
      {
        type: "command_execution",
        id: "create",
        runId,
        ordinal: 1,
        status: "completed",
        input: "gh pr create",
        output:
          "https://github.com/SpiritDevs/pathway/pull/41\nhttps://github.com/SpiritDevs/pathway/pull/42",
      },
    ],
  } as unknown as OrchestrationV2ThreadProjection;
  const commit = vi.fn<EventSinkV2["Service"]["commitCommand"]>((input) => {
    projection = {
      ...projection,
      turnItems: [
        ...projection.turnItems,
        ...input.events.flatMap((event) =>
          event.type === "turn-item.updated" ? [event.payload] : [],
        ),
      ],
    };
    return Effect.succeed({
      committed: true,
      cancelledEffectCount: 0,
      storedEvents: [],
      receipt: {
        commandId: input.commandId,
        threadId: input.threadId,
        commandType: input.commandType,
        acceptedAt: input.acceptedAt,
        resultSequence: 1,
        status: "accepted",
        error: null,
      },
    });
  });
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(EventSinkV2)({ commitCommand: commit }),
        Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({
          execute: () =>
            Effect.sync(() => {
              assert.equal(commit.mock.calls.length, 1);
            }),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadProjection: () => Effect.succeed(projection),
        }),
        Layer.succeed(RunFinalization.RunFinalizationObserver, {
          refresh: () => Effect.succeed(vcsStatus),
        }),
      ),
    ),
  );
  return Effect.gen(function* () {
    const service = yield* RunFinalization.RunFinalizationService;
    yield* service.finalize({ threadId, runId, scopeId });
    assert.equal(commit.mock.calls.length, 1);
    assert.deepEqual(
      commit.mock.calls[0]?.[0].events.map((event) =>
        event.type === "turn-item.updated" && event.payload.type === "source_control"
          ? event.payload.pullRequest?.number
          : null,
      ),
      [41, 42],
    );
    projection = {
      ...projection,
      turnItems: projection.turnItems.map((item) =>
        item.type === "source_control" ? { ...item, pullRequestAction: "detached" } : item,
      ),
    };
    yield* service.finalize({ threadId, runId, scopeId });
    assert.equal(commit.mock.calls.length, 1);
  }).pipe(Effect.provide(layer));
});

it("ignores PR links from commands that only view PRs and discovers creation through tool wrappers", () => {
  const items = [
    {
      type: "command_execution",
      status: "completed",
      input: "gh pr view 99",
      output: "https://github.com/SpiritDevs/pathway/pull/99",
    },
    {
      type: "dynamic_tool",
      status: "completed",
      input: { cmd: "glab mr create" },
      output: {
        stdout:
          "https://gitlab.com/group/repo/-/merge_requests/7\nhttps://gitlab.com/group/repo/-/merge_requests/8",
      },
    },
  ] as unknown as OrchestrationV2ThreadProjection["turnItems"];
  assert.deepEqual(RunFinalization.detectedThreadPullRequests(items, null), [
    { number: 7, url: "https://gitlab.com/group/repo/-/merge_requests/7" },
    { number: 8, url: "https://gitlab.com/group/repo/-/merge_requests/8" },
  ]);
});
