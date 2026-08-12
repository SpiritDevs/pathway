import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const now = "2026-08-12T00:00:00.000Z";

const asEventId = (value: string): EventId => EventId.make(value);
const asProjectId = (value: string): ProjectId => ProjectId.make(value);

/** Puts a project into the read model the way the event store would on replay. */
const projectCreated = (input: {
  readonly sequence: number;
  readonly projectId: string;
  readonly title: string;
  readonly workspaceRoot: string | null;
}) =>
  ({
    sequence: input.sequence,
    eventId: asEventId(`evt-create-${input.projectId}`),
    aggregateKind: "project",
    aggregateId: asProjectId(input.projectId),
    type: "project.created",
    occurredAt: now,
    commandId: CommandId.make(`cmd-create-${input.projectId}`),
    causationEventId: null,
    correlationId: CommandId.make(`cmd-create-${input.projectId}`),
    metadata: {},
    payload: {
      projectId: asProjectId(input.projectId),
      title: input.title,
      workspaceRoot: input.workspaceRoot,
      defaultModelSelection: null,
      scripts: [],
      createdAt: now,
      updatedAt: now,
    },
  }) as const;

it.layer(NodeServices.layer)("decider rootless projects", (it) => {
  it.effect("creates a project from a title alone and projects a null workspace root", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-create-rootless"),
          projectId: asProjectId("project-rootless"),
          title: "Rootless",
          workspaceRoot: null,
          createdAt: now,
        },
        readModel: createEmptyReadModel(now),
      });

      const event = Array.isArray(result) ? result[0]! : result;
      expect(event.type).toBe("project.created");
      expect((event.payload as { workspaceRoot: string | null }).workspaceRoot).toBeNull();

      const projected = yield* projectEvent(createEmptyReadModel(now), {
        ...event,
        sequence: 1,
      });
      expect(projected.projects).toHaveLength(1);
      expect(projected.projects[0]?.workspaceRoot).toBeNull();
      expect(projected.projects[0]?.title).toBe("Rootless");
    }),
  );

  it.effect("attaches a directory to a rootless project through project.meta.update", () =>
    Effect.gen(function* () {
      const readModel = yield* projectEvent(
        createEmptyReadModel(now),
        projectCreated({
          sequence: 1,
          projectId: "project-rootless",
          title: "Rootless",
          workspaceRoot: null,
        }),
      );
      expect(readModel.projects[0]?.workspaceRoot).toBeNull();

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-attach-root"),
          projectId: asProjectId("project-rootless"),
          workspaceRoot: "/tmp/attached",
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0]! : result;
      expect(event.type).toBe("project.meta-updated");
      expect((event.payload as { workspaceRoot?: string }).workspaceRoot).toBe("/tmp/attached");

      const attached = yield* projectEvent(readModel, { ...event, sequence: 2 });
      expect(attached.projects[0]?.workspaceRoot).toBe("/tmp/attached");
    }),
  );

  it.effect("allows a second rootless project: an absent path clashes with nothing", () =>
    Effect.gen(function* () {
      const readModel = yield* projectEvent(
        createEmptyReadModel(now),
        projectCreated({
          sequence: 1,
          projectId: "project-rootless-first",
          title: "First",
          workspaceRoot: null,
        }),
      );

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-create-rootless-second"),
          projectId: asProjectId("project-rootless-second"),
          title: "Second",
          workspaceRoot: null,
          createdAt: now,
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0]! : result;
      const projected = yield* projectEvent(readModel, { ...event, sequence: 2 });
      expect(projected.projects.map((project) => project.workspaceRoot)).toEqual([null, null]);
    }),
  );

  it.effect("does not treat a rootless project as occupying a path", () =>
    Effect.gen(function* () {
      const readModel = yield* projectEvent(
        createEmptyReadModel(now),
        projectCreated({
          sequence: 1,
          projectId: "project-rootless",
          title: "Rootless",
          workspaceRoot: null,
        }),
      );

      const result = yield* decideOrchestrationCommand({
        command: {
          type: "project.create",
          commandId: CommandId.make("cmd-create-rooted"),
          projectId: asProjectId("project-rooted"),
          title: "Rooted",
          workspaceRoot: "/tmp/rooted",
          createdAt: now,
        },
        readModel,
      });

      const event = Array.isArray(result) ? result[0]! : result;
      expect((event.payload as { workspaceRoot: string | null }).workspaceRoot).toBe("/tmp/rooted");
    }),
  );

  it.effect("refuses to create a thread in a rootless project, and allows it once attached", () =>
    Effect.gen(function* () {
      const rootless = yield* projectEvent(
        createEmptyReadModel(now),
        projectCreated({
          sequence: 1,
          projectId: "project-rootless",
          title: "Rootless",
          workspaceRoot: null,
        }),
      );
      const threadCreate = {
        type: "thread.create",
        commandId: CommandId.make("cmd-thread-create"),
        threadId: ThreadId.make("thread-1"),
        projectId: asProjectId("project-rootless"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5-codex",
        },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt: now,
      } as const;

      const failure = yield* Effect.flip(
        decideOrchestrationCommand({ command: threadCreate, readModel: rootless }),
      );
      expect(failure.message).toContain("has no workspace root");

      const attachEvent = yield* decideOrchestrationCommand({
        command: {
          type: "project.meta.update",
          commandId: CommandId.make("cmd-attach-root"),
          projectId: asProjectId("project-rootless"),
          workspaceRoot: "/tmp/attached",
        },
        readModel: rootless,
      });
      const attached = yield* projectEvent(rootless, {
        ...(Array.isArray(attachEvent) ? attachEvent[0]! : attachEvent),
        sequence: 2,
      });

      const created = yield* decideOrchestrationCommand({
        command: threadCreate,
        readModel: attached,
      });
      expect((Array.isArray(created) ? created[0]! : created).type).toBe("thread.created");
    }),
  );

  it.effect("still rejects a second project on a path a rooted project already holds", () =>
    Effect.gen(function* () {
      const readModel = yield* projectEvent(
        createEmptyReadModel(now),
        projectCreated({
          sequence: 1,
          projectId: "project-rooted",
          title: "Rooted",
          workspaceRoot: "/tmp/rooted",
        }),
      );

      const failure = yield* Effect.flip(
        decideOrchestrationCommand({
          command: {
            type: "project.meta.update",
            commandId: CommandId.make("cmd-attach-taken-root"),
            projectId: asProjectId("project-rootless"),
            workspaceRoot: "/tmp/rooted",
          },
          readModel: yield* projectEvent(
            readModel,
            projectCreated({
              sequence: 2,
              projectId: "project-rootless",
              title: "Rootless",
              workspaceRoot: null,
            }),
          ),
        }),
      );

      expect(failure.message).toContain(
        "Active project 'project-rooted' already exists for workspace root '/tmp/rooted'.",
      );
    }),
  );
});
