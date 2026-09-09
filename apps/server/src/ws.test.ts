import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import {
  ChatAttachment,
  ChatAttachmentId,
  CommandId,
  MessageId,
  ProjectId,
  type SnapShotSource,
  ThreadId,
} from "@spiritdevs/contracts";
import * as ServerConfig from "./config.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import { resolveAttachmentPath } from "./attachmentStore.ts";
import {
  ATTACHMENT_UPLOAD_ROUTE_PREFIX,
  issueAttachmentUploadUrl,
  storeAttachmentUpload,
  validateAttachmentUploadToken,
} from "./assets/AttachmentUpload.ts";
import { MembershipId } from "@spiritdevs/contracts/company";

import {
  persistChatAttachments,
  resolveAvailableEditorsForConfig,
  refreshLocalGitStatusAfterMutation,
  requireThreadResumeTarget,
  resolveIssueConnectionActor,
  wsProjectUpdateInputFromMutation,
} from "./ws.ts";

it.effect(
  "rejects a cached thread resume when the owning environment no longer has the thread",
  () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread:missing-cached-resume");
      const failure = yield* Effect.flip(requireThreadResumeTarget(threadId, Effect.succeed(null)));

      assert.strictEqual(failure._tag, "OrchestrationV2GetThreadProjectionError");
      assert.strictEqual(failure.threadId, threadId);
    }),
);

it.effect("allows a cached thread resume when the owning environment still has the thread", () =>
  requireThreadResumeTarget(
    ThreadId.make("thread:existing-cached-resume"),
    Effect.succeed({ exists: true }),
  ),
);

it.effect("waits for local Git status before completing a ref mutation", () =>
  Effect.gen(function* () {
    const refreshStarted = yield* Deferred.make<void>();
    const releaseRefresh = yield* Deferred.make<void>();
    const mutationResult = { refName: "feature/selected" };

    const mutationFiber = yield* refreshLocalGitStatusAfterMutation(
      "/repo",
      Effect.succeed(mutationResult),
      () =>
        Deferred.succeed(refreshStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRefresh)),
        ),
    ).pipe(Effect.forkChild);

    yield* Deferred.await(refreshStarted);
    assert.isUndefined(mutationFiber.pollUnsafe());

    yield* Deferred.succeed(releaseRefresh, undefined);
    assert.deepStrictEqual(yield* Fiber.join(mutationFiber), mutationResult);
  }),
);

it.effect("bounds the local Git status wait without cancelling the refresh", () =>
  Effect.gen(function* () {
    const refreshStarted = yield* Deferred.make<void>();
    const releaseRefresh = yield* Deferred.make<void>();
    const refreshCompleted = yield* Deferred.make<void>();
    const mutationResult = { refName: "feature/selected" };

    const mutationFiber = yield* refreshLocalGitStatusAfterMutation(
      "/repo",
      Effect.succeed(mutationResult),
      () =>
        Deferred.succeed(refreshStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRefresh)),
          Effect.andThen(Deferred.succeed(refreshCompleted, undefined)),
        ),
      Duration.seconds(2),
    ).pipe(Effect.forkChild);

    yield* Deferred.await(refreshStarted);
    yield* TestClock.adjust(Duration.seconds(2));

    assert.deepStrictEqual(yield* Fiber.join(mutationFiber), mutationResult);
    assert.isFalse(yield* Deferred.isDone(refreshCompleted));

    yield* Deferred.succeed(releaseRefresh, undefined);
    yield* Deferred.await(refreshCompleted);
  }),
);

it.each(["worktree" as const, null])(
  "forwards the project workspace override through WebSocket RPC: %s",
  (defaultThreadEnvMode) => {
    const commandId = CommandId.make("command:ws-project-workspace");
    const projectId = ProjectId.make("project:ws-mutation");
    assert.deepEqual(
      wsProjectUpdateInputFromMutation({
        type: "project.update",
        commandId,
        projectId,
        defaultThreadEnvMode,
      }),
      { commandId, projectId, defaultThreadEnvMode },
    );
  },
);

it.effect("does not block server config when editor discovery never resolves", () =>
  Effect.gen(function* () {
    const discoveryInterrupted = yield* Deferred.make<void>();
    const responseFiber = yield* resolveAvailableEditorsForConfig(
      Effect.never.pipe(
        Effect.onInterrupt(() => Deferred.succeed(discoveryInterrupted, undefined)),
      ),
    ).pipe(Effect.forkChild);

    yield* TestClock.adjust(Duration.seconds(5));

    const availableEditors = yield* Fiber.join(responseFiber);
    yield* Deferred.await(discoveryInterrupted);
    assert.deepEqual(availableEditors, []);
  }),
);

it.effect(
  "attributes cloud sessions to their replica membership and preserves legacy fallback",
  () =>
    Effect.gen(function* () {
      const member = { kind: "member" as const, membershipId: MembershipId.make("membership-1") };
      const tracker = {
        linkedMemberActor: Effect.succeed(member),
        memberActorForCloudUserId: (userId: string) =>
          Effect.succeed(userId === "user-1" ? member : null),
      };
      assert.deepEqual(
        yield* resolveIssueConnectionActor({ subject: "cloud-connect" }, tracker),
        member,
      );
      assert.deepEqual(yield* resolveIssueConnectionActor({ subject: "user-1" }, tracker), member);
      assert.deepEqual(
        yield* resolveIssueConnectionActor({ subject: "desktop-bootstrap" }, tracker),
        {
          kind: "user",
        },
      );
    }),
);

const decodeChatAttachment = Schema.decodeUnknownEffect(ChatAttachment);

const snapShotSource: SnapShotSource = {
  kind: "snap-shot",
  capturedAt: "2026-09-09T00:00:00.000Z",
  appName: "Browser",
  windowTitle: "Checkout",
  appIdentifier: "com.example.browser",
  appIconDataUrl: "data:image/png;base64,aWNvbg==",
  accessibility: { format: "flat-text", text: "Pay now", truncated: false },
};
const attachmentTestLayer = ServerSecretStore.layer.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "pathway-snapshot-persist-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.effect(
  "preserves SnapShot metadata and deterministic attachment IDs through inline upload retries",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const input = {
        threadId: ThreadId.make("thread-snapshot"),
        messageId: MessageId.make("message-snapshot"),
        attachments: [
          {
            type: "image" as const,
            name: "Browser.png",
            mimeType: "image/png",
            sizeBytes: bytes.length,
            dataUrl: `data:image/png;base64,${Encoding.encodeBase64(bytes)}`,
            source: snapShotSource,
          },
        ],
      };
      const first = yield* persistChatAttachments(input);
      const retried = yield* persistChatAttachments(input);
      assert.deepEqual(retried, first);
      assert.deepEqual(
        first[0] && "source" in first[0] ? first[0].source : undefined,
        snapShotSource,
      );
      assert.deepEqual(yield* decodeChatAttachment(first[0]), first[0]);
      const savedPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment: first[0]!,
      });
      assert.deepEqual(yield* fs.readFile(savedPath!), bytes);
    }).pipe(Effect.provide(attachmentTestLayer)),
);

it.effect(
  "preserves SnapShot metadata when claiming HTTP uploads and retrying in another thread",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const bytes = new Uint8Array([1, 2, 3, 4]);
      const image = {
        type: "image" as const,
        name: "Browser.png",
        mimeType: "image/png",
        sizeBytes: bytes.length,
      };
      const issued = yield* issueAttachmentUploadUrl(image);
      const token = issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length);
      const claims = yield* validateAttachmentUploadToken(token);
      assert.isNotNull(claims);
      assert.deepEqual(yield* storeAttachmentUpload(claims!, bytes), { ok: true });
      const pending = {
        ...image,
        id: ChatAttachmentId.make(issued.attachmentId),
        source: snapShotSource,
      };
      const input = {
        threadId: ThreadId.make("thread-snapshot-first"),
        messageId: MessageId.make("message-snapshot"),
        attachments: [pending],
      };
      const first = yield* persistChatAttachments(input);
      const retry = yield* persistChatAttachments({
        ...input,
        threadId: ThreadId.make("thread-snapshot-retry"),
      });
      assert.notEqual(first[0]?.id, retry[0]?.id);
      for (const attachment of [pending, first[0]!, retry[0]!]) {
        assert.deepEqual("source" in attachment ? attachment.source : undefined, snapShotSource);
        assert.deepEqual(yield* decodeChatAttachment(attachment), attachment);
        const savedPath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment,
        });
        assert.deepEqual(yield* fs.readFile(savedPath!), bytes);
      }
      assert.deepEqual(yield* persistChatAttachments(input), first);
    }).pipe(Effect.provide(attachmentTestLayer)),
);
