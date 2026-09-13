// @effect-diagnostics nodeBuiltinImport:off -- Node Blob streams multipart uploads without buffering media.
// @effect-diagnostics anyUnknownInErrorContext:off -- Convex transport errors remain external at this worker boundary.
// @effect-diagnostics unknownInEffectCatch:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { api } from "@spiritdevs/backend/convexApi";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { ConvexClient } from "convex/browser";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { prepareLocalAsset } from "../mcp/toolkits/assets/AssetMcpService.ts";
import { forkParkedFiber } from "../serverActivation.ts";
import type { ConvexServiceTokenProvider } from "./convexServiceToken.ts";
import { getOrCreateCloudSyncDpopKeyPairFromSecretStore } from "./environmentKeys.ts";
import { previewCommands, runPreviewCommand } from "./assetPreviewProcessor.ts";
import {
  awaitCloudSyncLink,
  DEFAULT_SYNC_DAEMON_LINK_WAIT_ATTEMPTS,
  DEFAULT_SYNC_DAEMON_LINK_WAIT_INTERVAL,
  discoverCloudSyncCompanyIds,
  makeCloudSyncTokenProvider,
  resolveCloudSyncConfig,
  superviseCloudSyncCompanies,
} from "./syncDaemon.ts";

class PreviewFailure extends Data.TaggedError("PreviewFailure")<{ message: string }> {}
type Claim = {
  assetId: string;
  leaseToken: string;
  expiresAt: number;
  original: { url: string; name: string; mimeType: string; byteSize: number };
  required: string[];
};
const call = <A>(run: () => Promise<A>) => Effect.tryPromise({ try: run, catch: (error) => error });

/** Single-conversion concurrency per environment/company; reactive claims and fenced uploads. */
const processClaim = Effect.fn("assets.processClaim")(function* (
  client: ConvexClient,
  companyId: CompanyId,
  claim: Claim,
) {
  const fs = yield* FileSystem.FileSystem;
  const http = yield* HttpClient.HttpClient;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-preview-" });
  const input = NodePath.join(directory, "original");
  const response = yield* http.get(claim.original.url);
  if (response.status !== 200)
    return yield* Effect.fail(
      new PreviewFailure({ message: "The private original could not be read." }),
    );
  let received = 0;
  yield* Stream.run(
    response.stream.pipe(
      Stream.mapEffect((chunk) => {
        received += chunk.byteLength;
        return received > claim.original.byteSize
          ? Effect.fail(new PreviewFailure({ message: "Original exceeds its verified size." }))
          : Effect.succeed(chunk);
      }),
    ),
    fs.sink(input),
  );
  if (received !== claim.original.byteSize)
    return yield* Effect.fail(new PreviewFailure({ message: "Original download is incomplete." }));
  const outputs = yield* Effect.try(() =>
    previewCommands(input, directory, claim.original.mimeType),
  );
  for (const output of outputs) {
    if (!claim.required.includes(output.kind)) continue;
    yield* Effect.tryPromise({
      try: (signal) => runPreviewCommand([...output.args, output.path], signal),
      catch: (error) => error,
    });
    const file = yield* call(() => prepareLocalAsset(output.path, directory));
    const lease = { companyId, assetId: claim.assetId, leaseToken: claim.leaseToken };
    const upload = yield* call(() =>
      client.action(api.assets.prepareRepresentation, {
        ...lease,
        kind: output.kind,
        fileName: NodePath.basename(output.path),
        mimeType: output.mimeType,
        byteSize: file.byteSize,
        checksum: file.checksum,
      }),
    );
    const body = yield* call(async () => {
      const form = new FormData();
      form.append(
        "file",
        await NodeFS.openAsBlob(output.path, { type: output.mimeType }),
        NodePath.basename(output.path),
      );
      return form;
    });
    const uploaded = yield* http.execute(
      HttpClientRequest.put(upload.uploadUrl).pipe(
        HttpClientRequest.bodyFormData(body),
        HttpClientRequest.setHeader("Range", "bytes=0-"),
        HttpClientRequest.setHeader("x-uploadthing-version", "7.7.4"),
      ),
    );
    if (uploaded.status < 200 || uploaded.status >= 300)
      return yield* Effect.fail(
        new PreviewFailure({ message: `Preview upload failed (${uploaded.status}).` }),
      );
    yield* uploaded.text;
    yield* call(() =>
      client.action(api.assets.finalizeRepresentation, {
        ...lease,
        representationId: upload.representationId,
      }),
    );
  }
});

const runCompany = Effect.fn("assets.processingCompany")(function* (
  convexUrl: string,
  companyId: CompanyId,
  tokens: ConvexServiceTokenProvider,
) {
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => new ConvexClient(convexUrl)),
    (value) => Effect.promise(() => value.close()),
  );
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  client.setAuth(({ forceRefreshToken }) =>
    runPromise(
      (forceRefreshToken ? tokens.invalidate() : Effect.void).pipe(Effect.andThen(tokens.token)),
    ),
  );
  const wakeups = Stream.callback<unknown, unknown>(
    (queue) =>
      Effect.acquireRelease(
        Effect.sync(() =>
          client.onUpdate(
            api.assets.processingHead,
            { companyId },
            (head) => Queue.offerUnsafe(queue, head),
            (error) => Queue.failCauseUnsafe(queue, Cause.fail(error)),
          ),
        ),
        (unsubscribe) => Effect.sync(unsubscribe),
      ).pipe(Effect.asVoid),
    { bufferSize: 1, strategy: "sliding" },
  );
  yield* Stream.runForEach(wakeups, () =>
    Effect.gen(function* () {
      while (true) {
        const claim = yield* call(() => client.mutation(api.assets.claimProcessing, { companyId }));
        if (claim === null) return;
        yield* Effect.scoped(processClaim(client, companyId, claim)).pipe(
          Effect.catch((error) =>
            call(() =>
              client.mutation(api.assets.failProcessing, {
                companyId,
                assetId: claim.assetId,
                leaseToken: claim.leaseToken,
                error:
                  error instanceof Error
                    ? error.message.slice(0, 1000)
                    : "Preview preparation failed. Retry from Assets.",
              }),
            ).pipe(Effect.asVoid),
          ),
        );
      }
    }),
  );
});

export const assetProcessingWorkerLayer = () =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      if ((yield* Config.string("VITEST").pipe(Config.withDefault(""))).length > 0) return;
      const config = yield* resolveCloudSyncConfig;
      if (config._tag !== "Configured") return;
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
      yield* forkParkedFiber(
        Effect.gen(function* () {
          if (
            (yield* awaitCloudSyncLink({
              secrets,
              interval: DEFAULT_SYNC_DAEMON_LINK_WAIT_INTERVAL,
              attempts: DEFAULT_SYNC_DAEMON_LINK_WAIT_ATTEMPTS,
            })) === null
          )
            return;
          const dpopKeys = yield* getOrCreateCloudSyncDpopKeyPairFromSecretStore(secrets);
          const tokens = yield* makeCloudSyncTokenProvider({ environmentId, secrets, dpopKeys });
          yield* superviseCloudSyncCompanies({
            discover: () =>
              discoverCloudSyncCompanyIds({ convexUrl: config.settings.convexUrl, tokens }),
            runCompany: (companyId) =>
              Effect.scoped(runCompany(config.settings.convexUrl, companyId, tokens)),
            workerLabel: "asset-previews",
          });
        }).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterrupts(cause)
              ? Effect.void
              : Effect.logWarning("Asset preview worker stopped", { cause }),
          ),
        ),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Asset preview worker could not start", { cause }),
      ),
    ),
  );
