import { assert, describe, expect, it } from "@effect/vitest";
import { type RpcSession } from "@spiritdevs/client-runtime/rpc";
import {
  EMPTY_STORED_SYNC_STATE,
  SYNC_BOOTSTRAP_GENERATION,
  SYNC_DOCUMENT_SCHEMA_VERSION,
  type StoredSyncState,
} from "@spiritdevs/client-runtime/sync";
import {
  CloudProjectId,
  EnvironmentCommandId,
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@spiritdevs/contracts";
import { CompanyId } from "@spiritdevs/contracts/company";
import { AuthorizationEpoch, CompanyVersion, SyncEntityId } from "@spiritdevs/contracts/cloudSync";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import {
  EnvironmentCommandIssueUnavailableError,
  EnvironmentCommandIssuer,
  makeRemoteDispatch,
  resolveRemoteDispatchCompanyFromReplicas,
  RemoteDispatchUnavailableError,
} from "./remoteDispatch.ts";
import {
  PeerEnvironmentConnectionFailedError,
  PeerEnvironments,
  type PeerEnvironmentHandle,
} from "./peerEnvironments.ts";

const TARGET_ENVIRONMENT_ID = EnvironmentId.make("environment:remote-target");
const TARGET_PROJECT_ID = ProjectId.make("project:remote-target");
const CLOUD_PROJECT_ID = CloudProjectId.make("cloud-project:remote-target");
const COMMAND_ID = EnvironmentCommandId.make("environment-command:delegate-1");
const THREAD_ID = ThreadId.make("thread:remote-target");
const COMPANY_ID = CompanyId.make("company:remote-target");
const OTHER_COMPANY_ID = CompanyId.make("company:remote-other");

function companyReplica(
  companyId: CompanyId,
  cloudProjectId = CLOUD_PROJECT_ID,
  localProjectId = TARGET_PROJECT_ID,
): StoredSyncState {
  return {
    ...EMPTY_STORED_SYNC_STATE,
    checkpoint: {
      schemaVersion: SYNC_DOCUMENT_SCHEMA_VERSION,
      bootstrapGeneration: SYNC_BOOTSTRAP_GENERATION,
      companyId,
      cursor: CompanyVersion.make(1),
      authorizationEpoch: AuthorizationEpoch.make(1),
      bootstrapped: true,
    },
    entities: [
      {
        entityKind: "environmentBinding",
        entityId: SyncEntityId.make(`binding:${companyId}`),
        version: CompanyVersion.make(1),
        payload: {
          id: `binding:${companyId}`,
          cloudProjectId,
          environmentId: TARGET_ENVIRONMENT_ID,
          localProjectId,
          localWorkspaceRoot: "/workspace",
          status: "active",
          lastSeenAt: null,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    ],
  };
}

class TestRpcReplyLostError extends Schema.TaggedErrorClass<TestRpcReplyLostError>()(
  "TestRpcReplyLostError",
  { message: Schema.String },
) {}

const projection = {
  thread: {
    id: THREAD_ID,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
  },
  runs: [],
} as unknown as OrchestrationV2ThreadProjection;

const commandInput = (connectGrantToken?: string) => ({
  targetEnvironmentId: TARGET_ENVIRONMENT_ID,
  targetProjectId: TARGET_PROJECT_ID,
  cloudProjectId: CLOUD_PROJECT_ID,
  kind: "startThread" as const,
  args: {
    kind: "startThread" as const,
    prompt: "Implement the remote task.",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
  },
  idempotencyId: COMMAND_ID,
  ...(connectGrantToken === undefined ? {} : { connectGrantToken }),
});

function peerHandle(client: RpcSession["client"]): PeerEnvironmentHandle {
  return {
    targetEnvironmentId: TARGET_ENVIRONMENT_ID,
    session: {
      client,
      initialConfig: Effect.die("initial config should not be read with an explicit model"),
      ready: Effect.void,
      probe: Effect.void,
      closed: Effect.never,
    },
    close: Effect.void,
  };
}

const makeHarness = Effect.fn("RemoteDispatchTest.makeHarness")(function* (input: {
  readonly connect: PeerEnvironments["Service"]["connect"];
  readonly issue: EnvironmentCommandIssuer["Service"]["issue"];
}) {
  return yield* makeRemoteDispatch({ resolveCompany: () => Effect.succeed(COMPANY_ID) }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(PeerEnvironments, PeerEnvironments.of({ connect: input.connect })),
        Layer.succeed(
          EnvironmentCommandIssuer,
          EnvironmentCommandIssuer.of({ issue: input.issue }),
        ),
      ),
    ),
  );
});

describe("RemoteDispatch", () => {
  it("derives only one exact company/project binding", () => {
    expect(
      resolveRemoteDispatchCompanyFromReplicas(commandInput(), [
        { companyId: COMPANY_ID, replica: companyReplica(COMPANY_ID) },
        {
          companyId: OTHER_COMPANY_ID,
          replica: companyReplica(OTHER_COMPANY_ID, CloudProjectId.make("cloud-project:unrelated")),
        },
      ]),
    ).toBe(COMPANY_ID);
    expect(
      resolveRemoteDispatchCompanyFromReplicas(commandInput(), [
        { companyId: COMPANY_ID, replica: companyReplica(COMPANY_ID) },
        { companyId: OTHER_COMPANY_ID, replica: companyReplica(OTHER_COMPANY_ID) },
      ]),
    ).toBeNull();
    expect(
      resolveRemoteDispatchCompanyFromReplicas(commandInput(), [
        {
          companyId: COMPANY_ID,
          replica: companyReplica(
            COMPANY_ID,
            CLOUD_PROJECT_ID,
            ProjectId.make("project:remote-unrelated"),
          ),
        },
      ]),
    ).toBeNull();
  });

  it.effect("uses the direct RPC path and carries the environment command id", () =>
    Effect.gen(function* () {
      const directCommandIds: string[] = [];
      const issuerCalls: unknown[] = [];
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.launchThread]: (input: { readonly commandId: string }) =>
          Effect.sync(() => {
            directCommandIds.push(input.commandId);
            return { threadId: THREAD_ID, projection, resumed: false };
          }),
      } as unknown as RpcSession["client"];
      const remote = yield* makeHarness({
        connect: () => Effect.succeed(peerHandle(client)),
        issue: (input) => Effect.sync(() => void issuerCalls.push(input)),
      });

      const result = yield* remote.dispatch(commandInput("single-use-grant"));

      assert.equal(result.delivery, "direct");
      assert.deepEqual(directCommandIds, [COMMAND_ID]);
      assert.isEmpty(issuerCalls);
    }),
  );

  it.effect("falls back after a consumed grant and never retries that token", () =>
    Effect.gen(function* () {
      let directAttempts = 0;
      const issuedIds: string[] = [];
      const remote = yield* makeHarness({
        connect: () => {
          directAttempts += 1;
          return Effect.fail(
            new PeerEnvironmentConnectionFailedError({
              stage: "websocket",
              cause: "socket closed after grant consumption",
              grantConsumption: "consumed",
              retryRequiresFreshGrant: true,
            }),
          );
        },
        issue: (input) => Effect.sync(() => void issuedIds.push(input.id)),
      });

      const first = yield* remote.dispatch(commandInput("consumed-grant"));
      const second = yield* remote.dispatch(commandInput("consumed-grant"));

      assert.equal(first.delivery, "deferred");
      assert.equal(second.delivery, "deferred");
      assert.equal(directAttempts, 1);
      assert.deepEqual(issuedIds, [COMMAND_ID, COMMAND_ID]);
    }),
  );

  it.effect("uses deferred delivery only when no grant is supplied", () =>
    Effect.gen(function* () {
      let directAttempts = 0;
      const issuedIds: string[] = [];
      const remote = yield* makeHarness({
        connect: () => {
          directAttempts += 1;
          return Effect.die("direct must not be attempted without a grant");
        },
        issue: (input) => Effect.sync(() => void issuedIds.push(input.id)),
      });

      const result = yield* remote.dispatch(commandInput());

      assert.equal(result.delivery, "deferred");
      assert.equal(directAttempts, 0);
      assert.deepEqual(issuedIds, [COMMAND_ID]);
    }),
  );

  it.effect("names the missing grant and cloud sync capability", () =>
    Effect.gen(function* () {
      const remote = yield* makeHarness({
        connect: () => Effect.die("direct must not be attempted without a grant"),
        issue: () =>
          Effect.fail(
            new EnvironmentCommandIssueUnavailableError({
              reason: "cloud-sync-unavailable",
              message: "Cloud sync is disabled.",
            }),
          ),
      });

      const error = yield* remote.dispatch(commandInput()).pipe(Effect.flip);

      assert.instanceOf(error, RemoteDispatchUnavailableError);
      assert.deepEqual(error.missing, ["connect-grant", "cloud-sync"]);
      assert.include(error.message, "connect-grant");
      assert.include(error.message, "cloud-sync");
    }),
  );

  it.effect("does not enqueue a deferred command without a unique company route", () =>
    Effect.gen(function* () {
      let issuerCalls = 0;
      const remote = yield* makeRemoteDispatch({ resolveCompany: () => Effect.succeed(null) }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(
              PeerEnvironments,
              PeerEnvironments.of({
                connect: () => Effect.die("direct must not be attempted without a grant"),
              }),
            ),
            Layer.succeed(
              EnvironmentCommandIssuer,
              EnvironmentCommandIssuer.of({
                issue: () =>
                  Effect.sync(() => {
                    issuerCalls += 1;
                  }),
              }),
            ),
          ),
        ),
      );

      const error = yield* remote.dispatch(commandInput()).pipe(Effect.flip);

      assert.instanceOf(error, RemoteDispatchUnavailableError);
      assert.deepEqual(error.missing, ["connect-grant", "cloud-sync"]);
      assert.equal(issuerCalls, 0);
    }),
  );

  it.effect("does not enqueue a deferred start-thread command without a cloud project", () =>
    Effect.gen(function* () {
      let issuerCalls = 0;
      const remote = yield* makeHarness({
        connect: () => Effect.die("direct must not be attempted without a grant"),
        issue: () =>
          Effect.sync(() => {
            issuerCalls += 1;
          }),
      });

      const input = commandInput();
      const { cloudProjectId: _cloudProjectId, ...withoutCloudProject } = input;
      const error = yield* remote.dispatch(withoutCloudProject).pipe(Effect.flip);

      assert.instanceOf(error, RemoteDispatchUnavailableError);
      assert.deepEqual(error.missing, ["connect-grant", "cloud-sync"]);
      assert.include(error.deferredFailure, "cloud project binding");
      assert.equal(issuerCalls, 0);
    }),
  );

  it.effect("shares one target execution identity when direct landed before fallback", () =>
    Effect.gen(function* () {
      const executed = new Set<string>();
      let executions = 0;
      const executeOnce = (id: string) => {
        if (executed.has(id)) return;
        executed.add(id);
        executions += 1;
      };
      const client = {
        [ORCHESTRATION_V2_WS_METHODS.launchThread]: (input: { readonly commandId: string }) =>
          Effect.sync(() => executeOnce(input.commandId)).pipe(
            Effect.andThen(
              Effect.fail(
                new TestRpcReplyLostError({ message: "reply lost after durable launch" }),
              ),
            ),
          ),
      } as unknown as RpcSession["client"];
      const remote = yield* makeHarness({
        connect: () => Effect.succeed(peerHandle(client)),
        issue: (input) => Effect.sync(() => executeOnce(input.id)),
      });

      const result = yield* remote.dispatch(commandInput("ambiguous-reply-grant"));

      assert.equal(result.delivery, "deferred");
      assert.equal(executions, 1);
      assert.deepEqual([...executed], [COMMAND_ID]);
    }),
  );
});
