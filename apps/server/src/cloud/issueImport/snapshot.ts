/**
 * Read-only capture of the environment-local issue tracker for a cloud import dry run.
 *
 * The snapshot deliberately includes durable issue-domain state only. Enrichment runs, comment
 * agent runs, automation execution audits, provider state, Slack cursors, and other worker state
 * remain environment-local: they describe processes and resumability on this machine, not the
 * company issue model. Comment attachment bytes also stay on disk; this module records only the
 * owning rows, resolved file paths, and stat sizes so planning does not load large files.
 *
 * The current local tracker stores attachment ids on comments and derives their files from the
 * shared attachment directory. It has no separate local attachment metadata repository, so the
 * file name and MIME type below are derived from the resolved file extension. Slice M2 must turn
 * these descriptors into authoritative upload metadata (including a checksum) while streaming the
 * file.
 *
 * @module cloud/issueImport/snapshot
 */
import type {
  ChatAttachmentId,
  IssueComment,
  IssueCycle,
  IssueEvent,
  IssueId,
  IssueLabel,
  IssueMilestone,
  IssueRelation,
  IssueStatus,
  IssueThreadLink,
  IssueTodo,
  IssueTrackerConfig,
  IssueView,
} from "@spiritdevs/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveAttachmentPathById } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { IssueCommentRepository } from "../../persistence/Services/IssueComments.ts";
import { IssueCycleRepository } from "../../persistence/Services/IssueCycles.ts";
import { IssueEventRepository } from "../../persistence/Services/IssueEvents.ts";
import {
  IssueLabelRepository,
  type IssueLabelAssignment,
} from "../../persistence/Services/IssueLabels.ts";
import { IssueMilestoneRepository } from "../../persistence/Services/IssueMilestones.ts";
import { IssueRelationRepository } from "../../persistence/Services/IssueRelations.ts";
import { IssueRepository, type IssueRecord } from "../../persistence/Services/Issues.ts";
import { IssueStatusRepository } from "../../persistence/Services/IssueStatuses.ts";
import { IssueThreadLinkRepository } from "../../persistence/Services/IssueThreadLinks.ts";
import { IssueTodoRepository } from "../../persistence/Services/IssueTodos.ts";
import { IssueTrackerConfigRepository } from "../../persistence/Services/IssueTrackerConfig.ts";
import { IssueViewRepository } from "../../persistence/Services/IssueViews.ts";

/** An issue row composed with the label join table, exactly once for the whole snapshot. */
export interface LocalIssueSnapshotIssue extends IssueRecord {
  readonly labelIds: ReadonlyArray<IssueLabel["id"]>;
}

/**
 * Durable comment fields only. `agentRun` is runtime execution state and is intentionally absent;
 * its pinned mention is retained separately when one exists so the rendered historical mention is
 * not lost.
 */
export interface LocalIssueSnapshotComment extends Omit<
  IssueComment,
  "agentRun" | "attachmentIds"
> {
  readonly attachmentIds: ReadonlyArray<ChatAttachmentId>;
  readonly mentions: ReadonlyArray<NonNullable<IssueComment["agentRun"]>["mention"]>;
}

/** File descriptor for one attachment id referenced by a persisted comment. */
export interface LocalIssueSnapshotAttachment {
  readonly id: ChatAttachmentId;
  readonly issueId: IssueId;
  readonly commentId: IssueComment["id"];
  readonly filePath: string | null;
  readonly fileName: string;
  readonly mimeType: string;
  readonly byteSize: number | null;
  readonly createdAt: IssueComment["createdAt"];
  readonly updatedAt: IssueComment["createdAt"];
}

/** One immutable, internally consistent repository read used by the pure planner. */
export interface LocalIssueSnapshot {
  readonly capturedAt: number;
  readonly issues: ReadonlyArray<LocalIssueSnapshotIssue>;
  readonly statuses: ReadonlyArray<IssueStatus>;
  readonly labels: ReadonlyArray<IssueLabel>;
  readonly labelAssignments: ReadonlyArray<IssueLabelAssignment>;
  readonly milestones: ReadonlyArray<IssueMilestone>;
  readonly cycles: ReadonlyArray<IssueCycle>;
  readonly todos: ReadonlyArray<IssueTodo>;
  readonly relations: ReadonlyArray<IssueRelation>;
  readonly comments: ReadonlyArray<LocalIssueSnapshotComment>;
  readonly attachments: ReadonlyArray<LocalIssueSnapshotAttachment>;
  readonly auditEvents: ReadonlyArray<IssueEvent>;
  readonly threadLinks: ReadonlyArray<IssueThreadLink>;
  readonly views: ReadonlyArray<IssueView>;
  readonly trackerConfig: IssueTrackerConfig;
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".gif": "image/gif",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".tiff": "image/tiff",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

/** Reads every durable local issue repository and stats referenced attachment files. */
export const readLocalIssueSnapshot = Effect.fn("cloud.issue_import.read_local_snapshot")(
  function* () {
    const issuesRepository = yield* IssueRepository;
    const statusRepository = yield* IssueStatusRepository;
    const labelRepository = yield* IssueLabelRepository;
    const milestoneRepository = yield* IssueMilestoneRepository;
    const cycleRepository = yield* IssueCycleRepository;
    const todoRepository = yield* IssueTodoRepository;
    const relationRepository = yield* IssueRelationRepository;
    const commentRepository = yield* IssueCommentRepository;
    const eventRepository = yield* IssueEventRepository;
    const threadLinkRepository = yield* IssueThreadLinkRepository;
    const viewRepository = yield* IssueViewRepository;
    const trackerConfigRepository = yield* IssueTrackerConfigRepository;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const serverConfig = yield* ServerConfig;

    const base = yield* Effect.all(
      {
        issues: issuesRepository.listAll(),
        statuses: statusRepository.listAll(),
        labels: labelRepository.listAll(),
        labelAssignments: labelRepository.listAssignments(),
        milestones: milestoneRepository.listAll(),
        cycles: cycleRepository.listAll(),
        threadLinks: threadLinkRepository.listAll(),
        views: viewRepository.listAll(),
        trackerConfig: trackerConfigRepository.get(),
      },
      { concurrency: "unbounded" },
    );

    const children = yield* Effect.forEach(
      base.issues,
      (issue) =>
        Effect.all(
          {
            todos: todoRepository.listByIssue({ issueId: issue.id }),
            relations: relationRepository.listByIssue({ issueId: issue.id }),
            comments: commentRepository.listByIssue({ issueId: issue.id }),
            auditEvents: eventRepository.listByIssue({ issueId: issue.id }),
          },
          { concurrency: "unbounded" },
        ),
      { concurrency: "unbounded" },
    );

    const labelIdsByIssue = new Map<IssueId, Array<IssueLabel["id"]>>();
    for (const assignment of base.labelAssignments) {
      const labelIds = labelIdsByIssue.get(assignment.issueId) ?? [];
      labelIds.push(assignment.labelId);
      labelIdsByIssue.set(assignment.issueId, labelIds);
    }

    const relationById = new Map<IssueRelation["id"], IssueRelation>();
    const todos: IssueTodo[] = [];
    const comments: LocalIssueSnapshotComment[] = [];
    const auditEvents: IssueEvent[] = [];
    for (const group of children) {
      todos.push(...group.todos);
      for (const edge of group.relations) relationById.set(edge.relation.id, edge.relation);
      auditEvents.push(...group.auditEvents);
      for (const comment of group.comments) {
        comments.push({
          id: comment.id,
          issueId: comment.issueId,
          author: comment.author,
          body: comment.body,
          attachmentIds: comment.attachmentIds,
          mentions: comment.agentRun == null ? [] : [comment.agentRun.mention],
          createdAt: comment.createdAt,
          editedAt: comment.editedAt,
        });
      }
    }

    const attachments = yield* Effect.forEach(
      comments.flatMap((comment) =>
        comment.attachmentIds.map((attachmentId) => ({ attachmentId, comment })),
      ),
      ({ attachmentId, comment }) =>
        Effect.gen(function* () {
          const filePath = resolveAttachmentPathById({
            attachmentsDir: serverConfig.attachmentsDir,
            attachmentId,
          });
          const info =
            filePath === null
              ? null
              : yield* fileSystem.stat(filePath).pipe(Effect.orElseSucceed(() => null));
          const extension = filePath === null ? "" : path.extname(filePath).toLowerCase();
          return {
            id: attachmentId,
            issueId: comment.issueId,
            commentId: comment.id,
            filePath,
            fileName: filePath === null ? attachmentId : path.basename(filePath),
            mimeType: MIME_BY_EXTENSION[extension] ?? "application/octet-stream",
            byteSize: info?.type === "File" ? Number(info.size) : null,
            createdAt: comment.createdAt,
            updatedAt: comment.editedAt ?? comment.createdAt,
          } satisfies LocalIssueSnapshotAttachment;
        }),
      { concurrency: "unbounded" },
    );

    return {
      capturedAt: yield* Clock.currentTimeMillis,
      issues: base.issues.map((issue) => ({
        ...issue,
        labelIds: labelIdsByIssue.get(issue.id) ?? [],
      })),
      statuses: base.statuses,
      labels: base.labels,
      labelAssignments: base.labelAssignments,
      milestones: base.milestones,
      cycles: base.cycles,
      todos,
      relations: [...relationById.values()],
      comments,
      attachments,
      auditEvents,
      threadLinks: base.threadLinks,
      views: base.views,
      trackerConfig: base.trackerConfig,
    } satisfies LocalIssueSnapshot;
  },
);
