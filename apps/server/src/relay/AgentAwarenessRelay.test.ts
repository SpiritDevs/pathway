import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import { EnvironmentId, EventId, ProviderInstanceId, ThreadId } from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  PUBLISH_AGENT_ACTIVITY_SECRET,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_URL_SECRET,
} from "../cloud/config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { emptyProjection, threadShellFromProjection } from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AgentAwarenessRelay from "./AgentAwarenessRelay.ts";
import {
  resolveAgentAwarenessRelayActiveThreadIds,
  resolveAgentAwarenessRelayPublishSnapshot,
} from "./AgentAwarenessRelay.ts";

const now = DateTime.makeUnsafe("2026-09-08T12:00:00.000Z");
const threadId = ThreadId.make("conversation-awareness");
const environmentId = EnvironmentId.make("environment-awareness");
const providerInstanceId = ProviderInstanceId.make("codex");
const thread = {
  ...threadShellFromProjection(
    emptyProjection({
      type: "thread.created",
      id: EventId.make("created-awareness"),
      threadId,
      occurredAt: now,
      payload: {
        id: threadId,
        projectId: null,
        conversationCompanyId: CompanyId.make("company-one"),
        conversationPath: "/userdata/conversations/one",
        temporary: true,
        title: "Planning conversation",
        modelSelection: { instanceId: providerInstanceId, model: "gpt-5.4" },
        providerInstanceId,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
        createdBy: "user",
        creationSource: "web",
      },
    }),
  ),
  status: "running" as const,
};

describe("conversation relay awareness", () => {
  it("includes running conversations in startup discovery and single-thread publishing", () => {
    expect(
      resolveAgentAwarenessRelayActiveThreadIds({ environmentId, projects: [], threads: [thread] }),
    ).toEqual([threadId]);
    expect(
      resolveAgentAwarenessRelayPublishSnapshot({
        environmentId,
        threadId,
        thread: Option.some(thread),
        project: Option.none(),
      }),
    ).toMatchObject({
      reason: "snapshot",
      projectId: null,
      state: {
        projectTitle: "Conversation",
        conversationCompanyId: "company-one",
        phase: "running",
        threadTitle: "Planning conversation",
      },
    });
  });
  it("does not publish a conversation without company ownership", () => {
    const missingOwner = { ...thread, conversationCompanyId: null };
    expect(
      resolveAgentAwarenessRelayActiveThreadIds({
        environmentId,
        projects: [],
        threads: [missingOwner],
      }),
    ).toEqual([]);
    expect(
      resolveAgentAwarenessRelayPublishSnapshot({
        environmentId,
        threadId,
        thread: Option.some(missingOwner),
        project: Option.none(),
      }).state,
    ).toBeNull();
  });
});

describe("agent awareness publishing", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect("reads relay credentials only when the projected state changes", () => {
    const encoder = new TextEncoder();
    const secrets = new Map<string, Uint8Array>([
      [PUBLISH_AGENT_ACTIVITY_SECRET, encoder.encode("true")],
      [RELAY_URL_SECRET, encoder.encode("https://relay.example.test")],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, encoder.encode("environment-credential")],
    ]);
    const secretReads = new Map<string, number>();
    const getThreadShell = vi.fn(() => Effect.succeed(thread));
    const fetchMock = vi.fn(async () => Response.json({ ok: true, deliveries: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const layer = AgentAwarenessRelay.layer.pipe(
      Layer.provide([
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (name) =>
            Effect.sync(() => {
              secretReads.set(name, (secretReads.get(name) ?? 0) + 1);
              return Option.fromNullishOr(secrets.get(name));
            }),
          create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getEnvironmentId: Effect.succeed(environmentId),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({ getThreadShell }),
        Layer.mock(ProjectService.ProjectService)({}),
        NodeCrypto.layer,
      ]),
    );

    return Effect.gen(function* () {
      const relay = yield* AgentAwarenessRelay.AgentAwarenessRelay;
      yield* relay.publishThread(threadId);
      yield* relay.publishThread(threadId);
      yield* relay.publishThread(threadId);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(getThreadShell).toHaveBeenCalledTimes(3);
      expect(secretReads.get(PUBLISH_AGENT_ACTIVITY_SECRET)).toBe(3);
      expect(secretReads.get(RELAY_URL_SECRET)).toBe(1);
    }).pipe(Effect.provide(layer));
  });
});
