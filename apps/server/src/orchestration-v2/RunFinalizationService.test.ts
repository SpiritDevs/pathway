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

for (const refreshFails of [false, true])
  it.effect(
    `records discovered PRs before checkpointing, even when refresh fails: ${refreshFails}`,
    () => {
      let failRefresh = refreshFails;
      let refreshedStatus = vcsStatus;
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
      const capture = vi.fn(() =>
        Effect.sync(() => {
          assert.isAtLeast(commit.mock.calls.length, 1);
        }),
      );
      const layer = RunFinalization.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(EventSinkV2)({ commitCommand: commit }),
            Layer.mock(CheckpointCapture.CheckpointCaptureServiceV2)({ execute: capture }),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadProjection: () => Effect.succeed(projection),
            }),
            Layer.succeed(RunFinalization.RunFinalizationObserver, {
              refresh: () =>
                failRefresh
                  ? Effect.fail(
                      new RunFinalization.RunFinalizationRefreshError({
                        cwd: "/repo",
                        cause: new Error("checkout removed"),
                      }),
                    )
                  : Effect.succeed(refreshedStatus),
            }),
          ),
        ),
      );
      return Effect.gen(function* () {
        const service = yield* RunFinalization.RunFinalizationService;
        const result = yield* service.finalize({ threadId, runId, scopeId }).pipe(Effect.result);
        assert.equal(result._tag, refreshFails ? "Failure" : "Success");
        assert.equal(capture.mock.calls.length, 1);
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
        yield* service.finalize({ threadId, runId, scopeId }).pipe(Effect.result);
        assert.equal(capture.mock.calls.length, 2);
        assert.equal(commit.mock.calls.length, 1);
        failRefresh = false;
        refreshedStatus = {
          ...vcsStatus,
          pr: { ...vcsStatus.pr, number: 43, url: vcsStatus.pr.url.replace("42", "43") },
        };
        yield* service.finalize({ threadId, runId, scopeId });
        assert.equal(capture.mock.calls.length, 3);
        assert.equal(commit.mock.calls.length, 2);
        // A recovered refresh can discover another PR without reusing the previous receipt or item IDs.
        assert.notEqual(commit.mock.calls[0]![0].commandId, commit.mock.calls[1]![0].commandId);
        assert.notEqual(
          commit.mock.calls[0]![0].events[0]!.id,
          commit.mock.calls[1]![0].events[0]!.id,
        );
        assert.equal(
          projection.turnItems.filter((item) => item.type === "source_control").length,
          3,
        );
      }).pipe(Effect.provide(layer));
    },
  );

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

it("discovers Azure and Bitbucket creation output without attaching viewed PRs", () => {
  const azure = "https://dev.azure.com/acme/platform/_git/api/pullrequest/15";
  const bitbucket = "https://bitbucket.org/acme/web/pull-requests/16";
  const items = [
    {
      type: "command_execution",
      status: "completed",
      input: "az repos pr create --repository api",
      output: azure,
    },
    {
      type: "command_execution",
      status: "completed",
      input: "curl -X POST https://api.bitbucket.org/2.0/repositories/acme/web/pullrequests",
      output: { links: { html: { href: bitbucket } } },
    },
    {
      type: "dynamic_tool",
      status: "completed",
      toolName: "mcp__bitbucket__create_pull_request",
      input: {},
      output: "https://bitbucket.org/acme/other/pull-requests/17",
    },
    {
      type: "command_execution",
      status: "completed",
      input: "az repos pr show --id 99",
      output: azure.replace("15", "99"),
    },
    {
      type: "command_execution",
      status: "completed",
      input: "curl https://api.bitbucket.org/2.0/repositories/acme/web/pullrequests",
      output: bitbucket.replace("16", "99"),
    },
    {
      type: "command_execution",
      status: "failed",
      input: "az repos pr create",
      output: azure.replace("15", "98"),
    },
  ] as unknown as OrchestrationV2ThreadProjection["turnItems"];
  assert.deepEqual(RunFinalization.detectedThreadPullRequests(items, null), [
    { number: 15, url: azure },
    { number: 16, url: bitbucket },
    { number: 17, url: "https://bitbucket.org/acme/other/pull-requests/17" },
  ]);
});

it("normalizes Azure creation JSON when no web link is returned", () => {
  const items = [
    {
      type: "command_execution",
      status: "completed",
      input: "az repos pr create --repository api",
      output: JSON.stringify({
        pullRequestId: 18,
        title: "Feature",
        url: "https://dev.azure.com/acme/project-id/_apis/git/repositories/repo-id/pullRequests/18",
        repository: { name: "api", project: { name: "platform" } },
        sourceRefName: "refs/heads/feature",
        targetRefName: "refs/heads/main",
        status: "active",
      }),
    },
  ] as unknown as OrchestrationV2ThreadProjection["turnItems"];
  assert.deepEqual(RunFinalization.detectedThreadPullRequests(items, null), [
    { number: 18, url: "https://dev.azure.com/acme/platform/_git/api/pullrequest/18" },
  ]);
});
