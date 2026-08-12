import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  IssueStatusId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  IssueTrackerError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as IssueEnrichmentEngine from "../../../issues/IssueEnrichmentEngine.ts";
import * as SlackIntakeEngine from "../../../issues/slack/SlackIntakeEngine.ts";
import {
  IssueTrackerService,
  layer as issueTrackerLayer,
} from "../../../issues/IssueTrackerService.ts";
import { IssueCommentRepositoryLive } from "../../../persistence/Layers/IssueComments.ts";
import { IssueCycleRepositoryLive } from "../../../persistence/Layers/IssueCycles.ts";
import { IssueEnrichmentRunRepositoryLive } from "../../../persistence/Layers/IssueEnrichmentRuns.ts";
import { IssueEventRepositoryLive } from "../../../persistence/Layers/IssueEvents.ts";
import { IssueLabelRepositoryLive } from "../../../persistence/Layers/IssueLabels.ts";
import { IssueMilestoneRepositoryLive } from "../../../persistence/Layers/IssueMilestones.ts";
import { IssueRelationRepositoryLive } from "../../../persistence/Layers/IssueRelations.ts";
import { IssueRepositoryLive } from "../../../persistence/Layers/Issues.ts";
import { IssueStatusRepositoryLive } from "../../../persistence/Layers/IssueStatuses.ts";
import { IssueThreadLinkRepositoryLive } from "../../../persistence/Layers/IssueThreadLinks.ts";
import { IssueTodoRepositoryLive } from "../../../persistence/Layers/IssueTodos.ts";
import { IssueTrackerConfigRepositoryLive } from "../../../persistence/Layers/IssueTrackerConfig.ts";
import { IssueViewRepositoryLive } from "../../../persistence/Layers/IssueViews.ts";
import { ProjectionProjectRepositoryLive } from "../../../persistence/Layers/ProjectionProjects.ts";
import { SlackChannelWatchRepositoryLive } from "../../../persistence/Layers/SlackChannelWatches.ts";
import { SlackIntakeLedgerRepositoryLive } from "../../../persistence/Layers/SlackIntakeLedger.ts";
import { SqlitePersistenceMemory } from "../../../persistence/Layers/Sqlite.ts";
import { ProjectionProjectRepository } from "../../../persistence/Services/ProjectionProjects.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { IssuesToolkitHandlersLive } from "./handlers.ts";
import {
  IssuesToolkit,
  type IssuesMcpCommentResult,
  type IssuesMcpDetail,
  type IssuesMcpIssueResult,
  type IssuesMcpListResult,
  type IssuesMcpThreadLinksResult,
} from "./tools.ts";

const THREAD = ThreadId.make("thread-agent-1");
/** The driver behind the calling instance — `codex_personal` is one instance of it, not a driver. */
const AGENT_DRIVER = ProviderDriverKind.make("codex");
const PROJECT = ProjectId.make("project-alpha");
const OTHER_PROJECT = ProjectId.make("project-beta");

/** The credential an incoming tool call arrives on. `codex` here is the *driver*, not the slug. */
const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex_personal"),
  providerDriverKind: AGENT_DRIVER,
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};

/**
 * A real tracker over an in-memory database, with the toolkit's handlers on top. Nothing is
 * mocked: name resolution, the change log, and the soft delete are the things under test, and a
 * fake tracker would be a fake of exactly those.
 */
const TestLayer = Layer.mergeAll(
  issueTrackerLayer.pipe(
    Layer.provide(IssueEnrichmentEngine.layerStub),
    Layer.provide(SlackIntakeEngine.layerStub),
  ),
  IssuesToolkitHandlersLive,
).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      IssueRepositoryLive,
      IssueStatusRepositoryLive,
      IssueLabelRepositoryLive,
      IssueEventRepositoryLive,
      IssueTrackerConfigRepositoryLive,
      IssueMilestoneRepositoryLive,
      IssueCycleRepositoryLive,
      IssueTodoRepositoryLive,
      IssueRelationRepositoryLive,
      IssueCommentRepositoryLive,
      IssueViewRepositoryLive,
      IssueEnrichmentRunRepositoryLive,
      IssueThreadLinkRepositoryLive,
      SlackChannelWatchRepositoryLive,
      SlackIntakeLedgerRepositoryLive,
      ProjectionProjectRepositoryLive,
    ),
  ),
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-issues-mcp-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

type ToolName = keyof typeof IssuesToolkit.tools;

/**
 * Call a tool the way `McpServer.registerToolkit` does — through the toolkit's own dispatch, so
 * the parameter and success schemas are exercised rather than bypassed. The result is named by
 * the caller: the toolkit's own `handle` widens across every tool in the kit.
 */
const callTool = <Result>(name: ToolName, params: unknown) =>
  Effect.gen(function* () {
    const built = yield* IssuesToolkit;
    return yield* built.handle(name, params as never).pipe(
      Stream.unwrap,
      Stream.run(Sink.last()),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new IssueTrackerError({
                reason: "not-found",
                message: `Tool ${name} completed without returning a result`,
              }),
            ),
          onSome: Effect.succeed,
        }),
      ),
      Effect.map((handled) => handled.result as Result),
    );
  }).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, invocation));

const seedProject = (projectId: ProjectId, title: string) =>
  Effect.flatMap(ProjectionProjectRepository, (projects) =>
    projects.upsert({
      projectId,
      title,
      workspaceRoot: "/tmp/workspace",
      defaultModelSelection: null,
      defaultThreadEnvMode: null,
      scripts: [],
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
      deletedAt: null,
    }),
  );

describe("issues MCP toolkit", () => {
  it.effect("filters the list by status name, category, project, label, and text", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      yield* seedProject(PROJECT, "Pathway");
      yield* seedProject(OTHER_PROJECT, "Relay");
      const { label } = yield* tracker.createLabel({ name: "Bug", color: "#eb5757" });

      yield* tracker.create(
        {
          title: "Composer drops focus",
          statusId: IssueStatusId.make("in-progress"),
          projectId: PROJECT,
          labelIds: [label.id],
          priority: "high",
        },
        { kind: "user" },
      );
      yield* tracker.create(
        {
          title: "Relay reconnect storm",
          statusId: IssueStatusId.make("done"),
          projectId: OTHER_PROJECT,
        },
        { kind: "user" },
      );
      yield* tracker.create({ title: "Untriaged idea", triage: true }, { kind: "user" });

      const all = yield* callTool<IssuesMcpListResult>("issues_list", {});
      assert.strictEqual(all.matched, 3);
      assert.isFalse(all.truncated);

      const byStatusName = yield* callTool<IssuesMcpListResult>("issues_list", {
        status: "in progress",
      });
      assert.deepStrictEqual(
        byStatusName.issues.map((row: { readonly title: string }) => row.title),
        ["Composer drops focus"],
      );

      // The category is the point: an agent knows what "completed" means and cannot know that
      // this environment calls the column "Done".
      const byCategory = yield* callTool<IssuesMcpListResult>("issues_list", {
        statusCategory: "completed",
      });
      assert.deepStrictEqual(
        byCategory.issues.map((row: { readonly title: string }) => row.title),
        ["Relay reconnect storm"],
      );

      const byProject = yield* callTool<IssuesMcpListResult>("issues_list", { project: "relay" });
      assert.strictEqual(byProject.matched, 1);
      assert.strictEqual(byProject.issues[0]?.project, "Relay");

      const byLabel = yield* callTool<IssuesMcpListResult>("issues_list", { label: "bug" });
      assert.strictEqual(byLabel.matched, 1);

      const byPriority = yield* callTool<IssuesMcpListResult>("issues_list", { priority: "high" });
      assert.strictEqual(byPriority.matched, 1);

      const byQuery = yield* callTool<IssuesMcpListResult>("issues_list", { query: "reconnect" });
      assert.strictEqual(byQuery.matched, 1);

      const byKey = yield* callTool<IssuesMcpListResult>("issues_list", { query: "iss-1" });
      assert.strictEqual(byKey.matched, 1);

      const triageOnly = yield* callTool<IssuesMcpListResult>("issues_list", { triage: true });
      assert.strictEqual(triageOnly.matched, 1);
      assert.isTrue(triageOnly.issues[0]?.triage);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("reports truncation rather than pretending a page is the whole tracker", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      for (let index = 0; index < 5; index += 1) {
        yield* tracker.create({ title: `Issue ${index}` }, { kind: "user" });
      }

      const page = yield* callTool<IssuesMcpListResult>("issues_list", { limit: 2 });
      assert.strictEqual(page.matched, 5);
      assert.strictEqual(page.returned, 2);
      assert.isTrue(page.truncated);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "assembles a detail view from sub-issues, todos, relations, comments, and threads",
    () =>
      Effect.gen(function* () {
        const tracker = yield* IssueTrackerService;
        yield* seedProject(PROJECT, "Pathway");
        const { label } = yield* tracker.createLabel({ name: "Chore", color: "#f2994a" });
        const parent = yield* tracker.create(
          {
            title: "Ship the tracker",
            description: "The body.",
            projectId: PROJECT,
            labelIds: [label.id],
          },
          { kind: "user" },
        );
        const child = yield* tracker.create(
          { title: "Sub-task", parentId: parent.issue.id },
          { kind: "user" },
        );
        const blocker = yield* tracker.create({ title: "Blocker" }, { kind: "user" });

        yield* tracker.todoCreate({ issueId: parent.issue.id, text: "Write the docs" });
        yield* tracker.relationCreate(
          { issueId: blocker.issue.id, relatedIssueId: parent.issue.id, kind: "blocks" },
          { kind: "user" },
        );
        yield* tracker.commentCreate(
          { issueId: parent.issue.id, body: "Looking at it." },
          { kind: "user" },
        );
        yield* tracker.linkThread(
          { issueId: parent.issue.id, threadId: THREAD, origin: "start-work" },
          { kind: "user" },
        );

        const detail = yield* callTool<IssuesMcpDetail>("issues_get", {
          key: parent.issue.key.toLowerCase(),
        });

        assert.strictEqual(detail.key, parent.issue.key);
        assert.strictEqual(detail.description, "The body.");
        assert.strictEqual(detail.project, "Pathway");
        assert.deepStrictEqual(detail.labels, ["Chore"]);
        assert.deepStrictEqual(detail.subIssueKeys, [child.issue.key]);
        assert.deepStrictEqual(detail.todos, [{ text: "Write the docs", done: false }]);
        // One stored row, read from this issue's end: inbound `blocks` reads as blocked by.
        assert.deepStrictEqual(
          detail.relations.map((edge: { readonly relation: string; readonly key: string }) => [
            edge.relation,
            edge.key,
          ]),
          [["blocked by", blocker.issue.key]],
        );
        assert.deepStrictEqual(
          detail.comments.map((comment: { readonly author: string; readonly body: string }) => [
            comment.author,
            comment.body,
          ]),
          [["user", "Looking at it."]],
        );
        assert.deepStrictEqual(
          detail.threads.map((link: { readonly threadId: string }) => link.threadId),
          [THREAD],
        );
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("creates and updates by name, resolving status by category and project by title", () =>
    Effect.gen(function* () {
      yield* seedProject(PROJECT, "Pathway");
      const tracker = yield* IssueTrackerService;
      yield* tracker.milestoneCreate({ projectId: PROJECT, name: "Beta" });

      const created = yield* callTool<IssuesMcpIssueResult>("issues_create", {
        title: "Wire the toolkit",
        description: "From an agent.",
        status: "todo",
        priority: "urgent",
        project: "pathway",
        assignee: "agent",
        dueDate: "2026-09-01",
      });

      assert.strictEqual(created.issue.key, "ISS-1");
      assert.strictEqual(created.issue.status, "Todo");
      assert.strictEqual(created.issue.project, "Pathway");
      assert.strictEqual(created.issue.priority, "urgent");
      assert.strictEqual(created.issue.dueDate, "2026-09-01");
      // "agent" means the caller, and the caller is a driver rather than an instance slug.
      assert.strictEqual(created.issue.assignee, "agent:codex");

      const updated = yield* callTool<IssuesMcpIssueResult>("issues_update", {
        key: "iss-1",
        status: "completed",
        milestone: "Beta",
        assignee: "user",
      });
      assert.strictEqual(updated.issue.status, "Done");
      assert.strictEqual(updated.issue.statusCategory, "completed");
      assert.strictEqual(updated.issue.assignee, "user");

      const detail = yield* callTool<IssuesMcpDetail>("issues_get", { key: "ISS-1" });
      assert.strictEqual(detail.milestone, "Beta");

      const cleared = yield* callTool<IssuesMcpIssueResult>("issues_update", {
        key: "ISS-1",
        assignee: null,
        dueDate: null,
      });
      assert.strictEqual(cleared.issue.assignee, null);
      assert.strictEqual(cleared.issue.dueDate, null);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("creates labels that do not exist yet and adjusts the set without replacing it", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      yield* tracker.createLabel({ name: "Bug", color: "#eb5757" });

      yield* callTool<IssuesMcpIssueResult>("issues_create", {
        title: "Flaky spec",
        labels: ["bug", "flaky-test"],
      });

      const snapshot = yield* tracker.getSnapshot();
      assert.deepStrictEqual(snapshot.labels.map((label) => label.name).sort(), [
        "Bug",
        "flaky-test",
      ]);

      const detail = yield* callTool<IssuesMcpDetail>("issues_get", { key: "ISS-1" });
      assert.deepStrictEqual([...detail.labels].sort(), ["Bug", "flaky-test"]);

      yield* callTool<IssuesMcpIssueResult>("issues_update", {
        key: "ISS-1",
        addLabels: ["needs-repro"],
        removeLabels: ["Bug"],
      });
      const adjusted = yield* callTool<IssuesMcpDetail>("issues_get", { key: "ISS-1" });
      assert.deepStrictEqual([...adjusted.labels].sort(), ["flaky-test", "needs-repro"]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("answers a bad name with the valid options rather than a dead end", () =>
    Effect.gen(function* () {
      yield* Effect.flatMap(IssueTrackerService, (tracker) =>
        tracker.create({ title: "Anything" }, { kind: "user" }),
      );

      const statusError = yield* callTool<IssuesMcpIssueResult>("issues_update", {
        key: "ISS-1",
        status: "Shipped",
      }).pipe(Effect.flip);
      assert.strictEqual(statusError.reason, "not-found");
      assert.include(statusError.message, '"Backlog"');
      assert.include(statusError.message, '"In Progress"');
      assert.include(statusError.message, '"completed"');

      const projectError = yield* callTool<IssuesMcpIssueResult>("issues_update", {
        key: "ISS-1",
        project: "Nowhere",
      }).pipe(Effect.flip);
      assert.strictEqual(projectError.reason, "not-found");
      assert.include(projectError.message, "No project called");

      const issueError = yield* callTool<IssuesMcpDetail>("issues_get", { key: "ISS-404" }).pipe(
        Effect.flip,
      );
      assert.strictEqual(issueError.reason, "not-found");
      assert.include(issueError.message, "ISS-404");

      const assigneeError = yield* callTool<IssuesMcpIssueResult>("issues_update", {
        key: "ISS-1",
        assignee: "who knows",
      }).pipe(Effect.flip);
      assert.strictEqual(assigneeError.reason, "invalid");

      const labelConflict = yield* callTool<IssuesMcpIssueResult>("issues_update", {
        key: "ISS-1",
        labels: ["a"],
        addLabels: ["b"],
      }).pipe(Effect.flip);
      assert.strictEqual(labelConflict.reason, "invalid");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("attributes every agent write to the calling provider in the change log", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;

      yield* callTool<IssuesMcpIssueResult>("issues_create", { title: "Agent filed this" });
      yield* callTool<IssuesMcpIssueResult>("issues_update", { key: "ISS-1", priority: "high" });
      yield* callTool<IssuesMcpCommentResult>("issues_comment", {
        key: "ISS-1",
        body: "And commented.",
      });

      const snapshot = yield* tracker.getSnapshot();
      const issue = snapshot.issues[0]!;
      const { events } = yield* tracker.getEvents({ issueId: issue.id });

      assert.isAtLeast(events.length, 2);
      for (const event of events) {
        assert.deepStrictEqual(event.actor, { kind: "agent", provider: AGENT_DRIVER });
      }
      assert.isTrue(events.some((event) => event.kind === "created"));
      assert.isTrue(events.some((event) => event.field === "priority"));

      // Comments are their own record rather than a change-log row, and carry the same actor.
      const detail = yield* callTool<IssuesMcpDetail>("issues_get", { key: "ISS-1" });
      assert.strictEqual(detail.comments[0]?.author, "agent:codex");
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("soft-deletes and restores, attributed to the agent both ways", () =>
    Effect.gen(function* () {
      const tracker = yield* IssueTrackerService;
      yield* callTool<IssuesMcpIssueResult>("issues_create", { title: "Filed by mistake" });

      const deleted = yield* callTool<IssuesMcpIssueResult>("issues_delete", { key: "ISS-1" });
      assert.isNotNull(deleted.issue.deletedAt);

      const hidden = yield* callTool<IssuesMcpListResult>("issues_list", {});
      assert.strictEqual(hidden.matched, 0);
      const visible = yield* callTool<IssuesMcpListResult>("issues_list", { includeDeleted: true });
      assert.strictEqual(visible.matched, 1);
      // The bin is readable, which is what makes a bad sweep reviewable before undoing it.
      const stillReadable = yield* callTool<IssuesMcpDetail>("issues_get", { key: "ISS-1" });
      assert.isNotNull(stillReadable.deletedAt);

      const restored = yield* callTool<IssuesMcpIssueResult>("issues_restore", { key: "ISS-1" });
      assert.isNull(restored.issue.deletedAt);

      const snapshot = yield* tracker.getSnapshot();
      const { events } = yield* tracker.getEvents({ issueId: snapshot.issues[0]!.id });
      const kinds = events.map((event) => event.kind);
      assert.include(kinds, "deleted");
      assert.include(kinds, "restored");
      for (const event of events) {
        assert.deepStrictEqual(event.actor, { kind: "agent", provider: AGENT_DRIVER });
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("links the calling agent's own thread by default and stays idempotent", () =>
    Effect.gen(function* () {
      yield* callTool<IssuesMcpIssueResult>("issues_create", { title: "Start work on this" });

      const linked = yield* callTool<IssuesMcpThreadLinksResult>("issues_link_thread", {
        key: "ISS-1",
      });
      assert.deepStrictEqual(
        linked.threads.map((link: { readonly threadId: string }) => link.threadId),
        [THREAD],
      );

      const again = yield* callTool<IssuesMcpThreadLinksResult>("issues_link_thread", {
        key: "ISS-1",
      });
      assert.strictEqual(again.threads.length, 1);

      const explicit = yield* callTool<IssuesMcpThreadLinksResult>("issues_link_thread", {
        key: "ISS-1",
        threadId: "thread-someone-else",
      });
      assert.strictEqual(explicit.threads.length, 2);
    }).pipe(Effect.provide(TestLayer)),
  );
});
