/** Publishes parsed SMTP captures to Convex for cross-environment reading. */
import { api } from "@spiritdevs/backend/convexApi";
import {
  CapturedEmailMessage,
  type EnvironmentId,
  type EmailMessageId,
} from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { EmailStore } from "../email/EmailStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { forkParkedFiber } from "../serverActivation.ts";
import type { ConvexServiceTokenProvider } from "./convexServiceToken.ts";
import { getOrCreateCloudSyncDpopKeyPairFromSecretStore } from "./environmentKeys.ts";
import {
  type ConvexClientLike,
  classifyConvexFailure,
  convexHttpClientLike,
} from "./convexSyncTransport.ts";
import {
  awaitCloudSyncLink,
  DEFAULT_SYNC_DAEMON_LINK_WAIT_ATTEMPTS,
  DEFAULT_SYNC_DAEMON_LINK_WAIT_INTERVAL,
  makeCloudSyncTokenProvider,
  resolveCloudSyncConfig,
} from "./syncDaemon.ts";

export const DEFAULT_CAPTURED_EMAIL_RECONCILE_INTERVAL = Duration.seconds(15);

interface CapturedEmailPublisherOptions {
  readonly companyId: CompanyId;
  readonly environmentId: EnvironmentId;
  readonly convexUrl: string;
  readonly tokens: ConvexServiceTokenProvider;
  readonly client?: ConvexClientLike;
  readonly reconcileInterval?: Duration.Input;
}

class CapturedEmailPublisherCallError extends Data.TaggedError("CapturedEmailPublisherCallError")<{
  readonly reason: ReturnType<typeof classifyConvexFailure>;
  readonly cause: unknown;
}> {}

const encodeMessage = Schema.encodeSync(CapturedEmailMessage);

/** Immutable capture content is keyed by stored time; only read state changes afterwards. */
export function capturedEmailPublicationIdentity(message: CapturedEmailMessage): string {
  return `${message.timings.storedAt}:${message.isRead ? "read" : "unread"}:${message.attribution.projectId ?? "unassigned"}`;
}

const makePublisher = Effect.fn("cloud.captured_email_publisher.make")(function* (
  options: CapturedEmailPublisherOptions,
) {
  const client = options.client ?? convexHttpClientLike(options.convexUrl);
  const lock = yield* Semaphore.make(1);
  const published = yield* Ref.make<ReadonlyMap<EmailMessageId, string>>(new Map());

  const call = <A>(token: string, issue: (client: ConvexClientLike) => Promise<A>) =>
    lock.withPermits(1)(
      Effect.tryPromise({
        try: () => {
          client.setAuth(token);
          return issue(client);
        },
        catch: (cause) =>
          new CapturedEmailPublisherCallError({
            reason: classifyConvexFailure(cause),
            cause,
          }),
      }),
    );
  const authorized = <A>(issue: (client: ConvexClientLike) => Promise<A>) =>
    Effect.gen(function* () {
      const token = yield* options.tokens.token;
      return yield* call(token, issue).pipe(
        Effect.catchIf(
          (error) => error.reason === "unauthorized",
          () =>
            options.tokens.invalidate(token).pipe(
              Effect.andThen(options.tokens.token),
              Effect.flatMap((refreshed) => call(refreshed, issue)),
            ),
        ),
      );
    });

  const publish = (message: CapturedEmailMessage) =>
    Effect.gen(function* () {
      const identity = capturedEmailPublicationIdentity(message);
      if ((yield* Ref.get(published)).get(message.id) === identity) return true;
      const accepted = yield* authorized((convex) =>
        convex.mutation(api.capturedEmails.upsert, {
          companyId: options.companyId,
          environmentId: options.environmentId,
          messageId: message.id,
          localProjectId: message.attribution.projectId,
          message: encodeMessage(message),
        }),
      );
      if (accepted === false) return false;
      yield* Ref.update(published, (current) => {
        const next = new Map(current);
        next.set(message.id, identity);
        return next;
      });
      return true;
    });

  const reconcileIds = (messageIds: ReadonlyArray<EmailMessageId>) =>
    authorized((convex) =>
      convex.mutation(api.capturedEmails.reconcile, {
        companyId: options.companyId,
        environmentId: options.environmentId,
        currentMessageIds: [...messageIds],
      }),
    ).pipe(
      Effect.tap(() =>
        Ref.update(published, (current) => {
          const live = new Set(messageIds);
          return new Map([...current].filter(([messageId]) => live.has(messageId)));
        }),
      ),
      Effect.asVoid,
    );

  return { publish, reconcileIds } as const;
});

export const runCapturedEmailPublisher = Effect.fn("cloud.captured_email_publisher.run")(function* (
  options: CapturedEmailPublisherOptions,
) {
  const store = yield* EmailStore;
  const publisher = yield* makePublisher(options);

  const reportFailure = (operation: string, messageId?: EmailMessageId) =>
    Effect.catchCause((cause) =>
      Effect.logWarning("Captured email publication failed; it will be retried", {
        companyId: options.companyId,
        environmentId: options.environmentId,
        operation,
        ...(messageId === undefined ? {} : { messageId }),
        cause,
      }),
    );

  const reconcile = Effect.gen(function* () {
    const messages = yield* store.allMessages;
    const outcomes = yield* Effect.forEach(
      messages,
      (message) =>
        publisher.publish(message).pipe(
          Effect.match({
            onFailure: () => ({ messageId: message.id, state: "failed" as const }),
            onSuccess: (accepted) => ({
              messageId: message.id,
              state: accepted === false ? ("deleted" as const) : ("live" as const),
            }),
          }),
        ),
      { concurrency: 4 },
    );
    const failedIds = outcomes
      .filter((outcome) => outcome.state === "failed")
      .map((outcome) => outcome.messageId);
    const deletedIds = outcomes
      .filter((outcome) => outcome.state === "deleted")
      .map((outcome) => outcome.messageId);
    if (deletedIds.length > 0) yield* store.deleteMessages(deletedIds);
    if (failedIds.length > 0) {
      yield* Effect.logWarning(
        "Some captured emails could not be published; the source copies remain available",
        {
          companyId: options.companyId,
          environmentId: options.environmentId,
          failedCount: failedIds.length,
          messageIds: failedIds.slice(0, 10),
        },
      );
    }
    yield* publisher.reconcileIds(
      outcomes.filter((outcome) => outcome.state !== "deleted").map((outcome) => outcome.messageId),
    );
  }).pipe(reportFailure("reconcile"));

  yield* reconcile;
  const captures = store.stored.pipe(
    Stream.map((message) => ({ _tag: "Capture" as const, message })),
  );
  const periodic = Stream.tick(
    options.reconcileInterval ?? DEFAULT_CAPTURED_EMAIL_RECONCILE_INTERVAL,
  ).pipe(Stream.map(() => ({ _tag: "Reconcile" as const })));

  yield* Stream.runForEach(Stream.merge(captures, periodic), (event) =>
    event._tag === "Reconcile"
      ? reconcile
      : publisher.publish(event.message).pipe(
          Effect.flatMap((accepted) =>
            accepted === false
              ? store.deleteMessages([event.message.id]).pipe(Effect.asVoid)
              : Effect.void,
          ),
          reportFailure("publish", event.message.id),
        ),
  );
});

/** Default-off publisher sharing the company link and proof-bound environment identity. */
export const capturedEmailPublisherLayer = (): Layer.Layer<
  never,
  never,
  | ServerSecretStore.ServerSecretStore
  | ServerEnvironment.ServerEnvironment
  | EmailStore
  | HttpClient.HttpClient
> =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const config = yield* resolveCloudSyncConfig;
      if (config._tag !== "Configured") return;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const environment = yield* ServerEnvironment.ServerEnvironment;
      const environmentId = yield* environment.getEnvironmentId;
      yield* forkParkedFiber(
        Effect.gen(function* () {
          const link = yield* awaitCloudSyncLink({
            secrets,
            interval: DEFAULT_SYNC_DAEMON_LINK_WAIT_INTERVAL,
            attempts: DEFAULT_SYNC_DAEMON_LINK_WAIT_ATTEMPTS,
          });
          if (link === null) return;
          const dpopKeys = yield* getOrCreateCloudSyncDpopKeyPairFromSecretStore(secrets).pipe(
            Effect.orDie,
          );
          const tokens = yield* makeCloudSyncTokenProvider({
            environmentId,
            secrets,
            dpopKeys,
          });
          yield* runCapturedEmailPublisher({
            companyId: config.settings.companyId,
            environmentId,
            convexUrl: config.settings.convexUrl,
            tokens,
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.void
              : Effect.logWarning("Captured email publisher stopped", { cause }),
          ),
        ),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Captured email publisher failed to start", { cause }),
      ),
    ),
  );
