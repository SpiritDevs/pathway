/**
 * Sets a company project's icon from the server, acting as this environment.
 *
 * The web client does the same through the member's own Convex session. Agents have no such
 * session, so the MCP `projects` toolkit writes through the environment identity instead — the
 * same identity that publishes project metadata, which already holds `projects.manage`.
 *
 * @module cloud/cloudProjectIcons
 */
import { api } from "@spiritdevs/backend/convexApi";
import type { ProjectIcon } from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import type { FunctionArgs } from "convex/server";
import { ConvexError } from "convex/values";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { type ConvexClientLike, convexHttpClientLike } from "./convexSyncTransport.ts";
import { getOrCreateCloudSyncDpopKeyPairFromSecretStore } from "./environmentKeys.ts";
import { makeCloudSyncTokenProvider, resolveCloudSyncConfig } from "./syncDaemon.ts";

export class CloudProjectIconError extends Data.TaggedError("CloudProjectIconError")<{
  readonly message: string;
}> {}

interface CloudProjectTarget {
  readonly companyId: CompanyId;
  readonly cloudProjectId: string;
}

export class CloudProjectIcons extends Context.Service<
  CloudProjectIcons,
  {
    /** A built-in library icon, or null to go back to the detected favicon. */
    readonly setIcon: (
      input: CloudProjectTarget & { readonly icon: ProjectIcon | null },
    ) => Effect.Effect<void, CloudProjectIconError>;
    /** Uploads an image every device shows in place of detected favicons and library icons. */
    readonly setImage: (
      input: CloudProjectTarget & { readonly bytes: Uint8Array; readonly mimeType: string },
    ) => Effect.Effect<void, CloudProjectIconError>;
  }
>()("@spiritdevs/pathway/cloud/cloudProjectIcons") {}

type StorageId = FunctionArgs<typeof api.cloudProjects.setCompanyProjectIconImage>["storageId"];

/** Convex storage answers an upload with the id of the stored file. */
const UploadResult = Schema.Struct({ storageId: Schema.String });

/** Convex refusals carry a human message; anything else is an outage the caller can retry. */
const describeFailure = (cause: unknown) =>
  new CloudProjectIconError({
    message:
      cause instanceof ConvexError &&
      typeof cause.data === "object" &&
      cause.data !== null &&
      typeof cause.data.message === "string"
        ? cause.data.message
        : "Pathway Cloud could not be reached to update the project icon. Retry shortly.",
  });

export const layer = Layer.effect(
  CloudProjectIcons,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const httpClient = yield* HttpClient.HttpClient;
    const config = yield* resolveCloudSyncConfig;
    const connect = yield* Effect.cached(
      Effect.gen(function* () {
        if (config._tag !== "Configured") {
          return yield* new CloudProjectIconError({
            message: "This environment is not connected to Pathway Cloud.",
          });
        }
        const environmentId = yield* environment.getEnvironmentId;
        const dpopKeys = yield* getOrCreateCloudSyncDpopKeyPairFromSecretStore(secrets);
        const tokens = yield* makeCloudSyncTokenProvider({ environmentId, secrets, dpopKeys }).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        );
        return {
          tokens,
          client: convexHttpClientLike(config.settings.convexUrl),
          lock: yield* Semaphore.make(1),
        };
      }).pipe(
        Effect.mapError((cause) =>
          cause instanceof CloudProjectIconError ? cause : describeFailure(cause),
        ),
      ),
    );

    const call = <A>(issue: (client: ConvexClientLike) => Promise<A>) =>
      Effect.gen(function* () {
        const backend = yield* connect;
        const token = yield* backend.tokens.token.pipe(Effect.mapError(describeFailure));
        return yield* backend.lock.withPermits(1)(
          Effect.tryPromise({
            try: () => {
              backend.client.setAuth(token);
              return issue(backend.client);
            },
            catch: describeFailure,
          }),
        );
      });

    return CloudProjectIcons.of({
      setIcon: ({ icon, ...target }) =>
        call((convex) =>
          convex.mutation(api.cloudProjects.setCompanyProjectIcon, { ...target, icon }),
        ).pipe(Effect.asVoid),
      setImage: ({ bytes, mimeType, ...target }) =>
        Effect.gen(function* () {
          const uploadUrl = yield* call((convex) =>
            convex.mutation(api.cloudProjects.generateProjectIconUploadUrl, target),
          );
          const { storageId } = yield* HttpClientRequest.post(uploadUrl).pipe(
            HttpClientRequest.bodyUint8Array(bytes, mimeType),
            httpClient.execute,
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(UploadResult)),
            Effect.mapError(
              () =>
                new CloudProjectIconError({ message: "The project icon could not be uploaded." }),
            ),
          );
          const accepted = yield* call((convex) =>
            convex.mutation(api.cloudProjects.setCompanyProjectIconImage, {
              ...target,
              storageId: storageId as StorageId,
            }),
          );
          if (!accepted) {
            return yield* new CloudProjectIconError({
              message: "A project icon must be an image of at most 1 MB.",
            });
          }
        }),
    });
  }),
);
