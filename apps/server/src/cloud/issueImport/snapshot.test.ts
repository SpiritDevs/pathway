import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChatAttachmentId,
  IssueCommentId,
  IssueCycleId,
  IssueEventId,
  IssueId,
  IssueKey,
  IssueLabelId,
  IssueMilestoneId,
  IssueRelationId,
  IssueStatusId,
  IssueTodoId,
  IssueViewId,
  ProjectId,
  ThreadId,
} from "@spiritdevs/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { ServerConfig } from "../../config.ts";
import { IssueCommentRepositoryLive } from "../../persistence/Layers/IssueComments.ts";
import { IssueCycleRepositoryLive } from "../../persistence/Layers/IssueCycles.ts";
import { IssueEventRepositoryLive } from "../../persistence/Layers/IssueEvents.ts";
import { IssueLabelRepositoryLive } from "../../persistence/Layers/IssueLabels.ts";
import { IssueMilestoneRepositoryLive } from "../../persistence/Layers/IssueMilestones.ts";
import { IssueRelationRepositoryLive } from "../../persistence/Layers/IssueRelations.ts";
import { IssueRepositoryLive } from "../../persistence/Layers/Issues.ts";
import { IssueStatusRepositoryLive } from "../../persistence/Layers/IssueStatuses.ts";
import { IssueThreadLinkRepositoryLive } from "../../persistence/Layers/IssueThreadLinks.ts";
import { IssueTodoRepositoryLive } from "../../persistence/Layers/IssueTodos.ts";
import { IssueTrackerConfigRepositoryLive } from "../../persistence/Layers/IssueTrackerConfig.ts";
import { IssueViewRepositoryLive } from "../../persistence/Layers/IssueViews.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { IssueCommentRepository } from "../../persistence/Services/IssueComments.ts";
import { IssueCycleRepository } from "../../persistence/Services/IssueCycles.ts";
import { IssueEventRepository } from "../../persistence/Services/IssueEvents.ts";
import { IssueLabelRepository } from "../../persistence/Services/IssueLabels.ts";
import { IssueMilestoneRepository } from "../../persistence/Services/IssueMilestones.ts";
import { IssueRelationRepository } from "../../persistence/Services/IssueRelations.ts";
import { IssueRepository } from "../../persistence/Services/Issues.ts";
import { IssueStatusRepository } from "../../persistence/Services/IssueStatuses.ts";
import { IssueThreadLinkRepository } from "../../persistence/Services/IssueThreadLinks.ts";
import { IssueTodoRepository } from "../../persistence/Services/IssueTodos.ts";
import { IssueTrackerConfigRepository } from "../../persistence/Services/IssueTrackerConfig.ts";
import { IssueViewRepository } from "../../persistence/Services/IssueViews.ts";
import { readLocalIssueSnapshot } from "./snapshot.ts";

const ISSUE_A = IssueId.make("issue-snapshot-a");
const ISSUE_B = IssueId.make("issue-snapshot-b");
const STATUS = IssueStatusId.make("status-snapshot");
const LABEL = IssueLabelId.make("label-snapshot");
const MILESTONE = IssueMilestoneId.make("milestone-snapshot");
const CYCLE = IssueCycleId.make("cycle-snapshot");
const TODO = IssueTodoId.make("todo-snapshot");
const RELATION = IssueRelationId.make("relation-snapshot");
const COMMENT = IssueCommentId.make("comment-snapshot");
const EVENT = IssueEventId.make("event-snapshot");
const VIEW = IssueViewId.make("view-snapshot");
const PROJECT = ProjectId.make("project-snapshot");
const THREAD = ThreadId.make("thread-snapshot");
const ATTACHMENT = ChatAttachmentId.make(
  "iss_issue-snapshot-a-00000000-0000-4000-8000-000000000001",
);
const CREATED = "2026-01-02T03:04:05.000Z";
const UPDATED = "2026-02-03T04:05:06.000Z";

const TestLayer = Layer.mergeAll(
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
  IssueThreadLinkRepositoryLive,
).pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "pathway-issue-import-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

describe("readLocalIssueSnapshot", () => {
  it.effect(
    "reads every durable issue kind, soft deletions, joins, and attachment file stats",
    () =>
      Effect.gen(function* () {
        const issues = yield* IssueRepository;
        const statuses = yield* IssueStatusRepository;
        const labels = yield* IssueLabelRepository;
        const milestones = yield* IssueMilestoneRepository;
        const cycles = yield* IssueCycleRepository;
        const todos = yield* IssueTodoRepository;
        const relations = yield* IssueRelationRepository;
        const comments = yield* IssueCommentRepository;
        const events = yield* IssueEventRepository;
        const links = yield* IssueThreadLinkRepository;
        const views = yield* IssueViewRepository;
        const trackerConfig = yield* IssueTrackerConfigRepository;
        const serverConfig = yield* ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* statuses.upsert({
          id: STATUS,
          name: "Snapshot",
          color: "#333333",
          category: "unstarted",
          position: 50,
          createdAt: CREATED,
          updatedAt: UPDATED,
        });
        yield* labels.upsert({ id: LABEL, name: "Snapshot", color: "#ff0000", createdAt: CREATED });
        yield* milestones.upsert({
          id: MILESTONE,
          projectId: PROJECT,
          name: "Snapshot milestone",
          description: null,
          startDate: null,
          targetDate: "2026-04-01",
          position: 0,
          createdAt: CREATED,
          updatedAt: UPDATED,
        });
        yield* cycles.upsert({
          id: CYCLE,
          name: "Snapshot cycle",
          startDate: "2026-01-01",
          endDate: "2026-01-31",
          completedAt: UPDATED,
          createdAt: CREATED,
          updatedAt: UPDATED,
        });
        yield* issues.upsertMany([
          {
            id: ISSUE_A,
            key: IssueKey.make("PAT-7"),
            title: "Snapshot A",
            description: "A",
            statusId: STATUS,
            priority: "high",
            assignee: { kind: "user" },
            projectId: PROJECT,
            milestoneId: MILESTONE,
            cycleId: CYCLE,
            parentId: null,
            sortOrder: "a0",
            dueDate: null,
            triage: false,
            slackSource: null,
            createdAt: CREATED,
            updatedAt: UPDATED,
            deletedAt: UPDATED,
          },
          {
            id: ISSUE_B,
            key: IssueKey.make("PAT-8"),
            title: "Snapshot B",
            description: "B",
            statusId: STATUS,
            priority: "none",
            assignee: null,
            projectId: null,
            milestoneId: null,
            cycleId: null,
            parentId: null,
            sortOrder: "b0",
            dueDate: null,
            triage: false,
            slackSource: null,
            createdAt: CREATED,
            updatedAt: UPDATED,
            deletedAt: null,
          },
        ]);
        yield* labels.setAssignments({ issueId: ISSUE_A, labelIds: [LABEL] });
        yield* todos.upsert({
          id: TODO,
          issueId: ISSUE_A,
          text: "Snapshot todo",
          done: true,
          position: 0,
        });
        yield* relations.insert({
          id: RELATION,
          issueId: ISSUE_A,
          relatedIssueId: ISSUE_B,
          kind: "blocks",
        });
        yield* comments.upsert({
          id: COMMENT,
          issueId: ISSUE_A,
          author: { kind: "user" },
          body: "Snapshot comment",
          attachmentIds: [ATTACHMENT],
          createdAt: CREATED,
          editedAt: UPDATED,
        });
        yield* events.append({
          id: EVENT,
          issueId: ISSUE_A,
          actor: { kind: "user" },
          kind: "field_changed",
          field: "priority",
          before: "none",
          after: "high",
          createdAt: CREATED,
        });
        yield* links.link({
          issueId: ISSUE_A,
          threadId: THREAD,
          createdAt: CREATED,
          origin: "manual",
        });
        yield* views.upsert({
          id: VIEW,
          name: "Snapshot view",
          position: 0,
          config: { tab: "all", grouping: "none", sortMode: "created", viewMode: "list" },
          createdAt: CREATED,
          updatedAt: UPDATED,
        });
        yield* trackerConfig.setPrefix({ keyPrefix: "PAT" });
        yield* trackerConfig.reserveKeyNumbers({ throughNumber: 8 });

        const attachmentPath = path.join(serverConfig.attachmentsDir, `${ATTACHMENT}.png`);
        yield* fileSystem.writeFile(attachmentPath, new Uint8Array([1, 2, 3, 4]));

        const snapshot = yield* readLocalIssueSnapshot();
        assert.equal(snapshot.issues.length, 2);
        assert.equal(snapshot.issues.find((issue) => issue.id === ISSUE_A)?.deletedAt, UPDATED);
        assert.deepEqual(snapshot.issues.find((issue) => issue.id === ISSUE_A)?.labelIds, [LABEL]);
        assert.ok(snapshot.statuses.some((status) => status.id === STATUS));
        assert.ok(snapshot.labels.some((label) => label.id === LABEL));
        assert.ok(snapshot.milestones.some((milestone) => milestone.id === MILESTONE));
        assert.ok(snapshot.cycles.some((cycle) => cycle.id === CYCLE));
        assert.deepEqual(
          snapshot.todos.map((todo) => todo.id),
          [TODO],
        );
        assert.deepEqual(
          snapshot.relations.map((relation) => relation.id),
          [RELATION],
        );
        assert.deepEqual(
          snapshot.comments.map((comment) => comment.id),
          [COMMENT],
        );
        assert.deepEqual(
          snapshot.auditEvents.map((event) => event.id),
          [EVENT],
        );
        assert.deepEqual(
          snapshot.threadLinks.map((link) => link.threadId),
          [THREAD],
        );
        assert.ok(snapshot.views.some((view) => view.id === VIEW));
        assert.deepEqual(snapshot.trackerConfig, { keyPrefix: "PAT", nextNumber: 9 });
        assert.equal(snapshot.attachments.length, 1);
        assert.equal(snapshot.attachments[0]?.filePath, attachmentPath);
        assert.equal(snapshot.attachments[0]?.mimeType, "image/png");
        assert.equal(snapshot.attachments[0]?.byteSize, 4);
        assert.ok(snapshot.capturedAt >= 0);
      }).pipe(Effect.provide(TestLayer)),
  );
});
