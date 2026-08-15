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
    url: "https://github.com/t3dotgg/pathway/pull/42",
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
    url: "https://github.com/t3dotgg/pathway/pull/42",
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
  } as unknown as OrchestrationV2ThreadProjection;
  const layer = RunFinalization.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
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
