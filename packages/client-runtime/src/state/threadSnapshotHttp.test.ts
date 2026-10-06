import {
  EnvironmentId,
  MessageId,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadDetailSnapshotWire,
  type OrchestrationV2TurnItem,
  TurnItemId,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { ManagedRelayDpopSigner, type ManagedRelayDpopProofInput } from "../relay/managedRelay.ts";
import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import {
  fetchEnvironmentThreadSnapshot,
  fetchEnvironmentToolOutput,
  ThreadSnapshotLoader,
  threadSnapshotLoaderLayer,
} from "./threadSnapshotHttp.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-history"),
  label: "History environment",
  httpBaseUrl: "https://environment.example.test/base",
  wsBaseUrl: "wss://environment.example.test",
});
const PREPARED: PreparedConnection = {
  environmentId: TARGET.environmentId,
  label: TARGET.label,
  httpBaseUrl: TARGET.httpBaseUrl,
  socketUrl: TARGET.wsBaseUrl,
  httpAuthorization: null,
  target: TARGET,
};
const SNAPSHOT: OrchestrationV2ThreadDetailSnapshot = {
  snapshotSequence: 42,
  projection: v2Projection,
  history: {
    hasOlder: true,
    hasNewer: false,
    beforeCursor: TurnItemId.make("item:50"),
    afterCursor: TurnItemId.make("item:99"),
    index: [{ messageId: MessageId.make("message:1"), role: "user", preview: "Earlier prompt" }],
  },
};
const encodeWireSnapshot = Schema.encodeSync(
  Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshotWire),
);

function httpHarness(snapshot: OrchestrationV2ThreadDetailSnapshotWire = SNAPSHOT) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchFn: typeof fetch = (request, init) => {
    calls.push({ url: new URL(String(request)), init: init ?? {} });
    return Promise.resolve(Response.json(encodeWireSnapshot(snapshot)));
  };
  return { calls, layer: remoteHttpClientLayer(fetchFn) };
}

describe("thread history HTTP requests", () => {
  for (const body of [
    {
      _tag: "EnvironmentAuthInvalidError",
      code: "auth_invalid",
      reason: "invalid_credential",
      traceId: "test-trace",
    },
    { message: "Unauthorized" },
  ]) {
    it.effect(
      `distinguishes HTTP 401 from transport failures (${"_tag" in body ? "typed" : "legacy"})`,
      () =>
        Effect.gen(function* () {
          const loader = yield* ThreadSnapshotLoader;
          expect(yield* loader.load(PREPARED, v2ThreadId)).toEqual({ _tag: "Unauthorized" });
        }).pipe(
          Effect.provide(
            threadSnapshotLoaderLayer.pipe(
              Layer.provide(
                remoteHttpClientLayer(() => Promise.resolve(Response.json(body, { status: 401 }))),
              ),
            ),
          ),
        ),
    );
  }
  it.effect("resolves compact wire items before returning a client snapshot", () =>
    Effect.gen(function* () {
      const item: OrchestrationV2TurnItem = {
        id: TurnItemId.make("item:compact"),
        threadId: v2ThreadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        type: "command_execution",
        status: "completed",
        title: null,
        input: "example",
        output: "first\n… output omitted …\nlast",
        outputPreview: { totalBytes: 100_000, format: "text" },
        startedAt: v2Now,
        completedAt: v2Now,
        updatedAt: v2Now,
      };
      const reference = {
        position: 50,
        visibility: "local" as const,
        sourceThreadId: v2ThreadId,
        sourceItemId: item.id,
      };
      const harness = httpHarness({
        ...SNAPSHOT,
        projection: {
          ...v2Projection,
          payloadFormat: "compact-v1",
          turnItems: [item],
          referencedTurnItems: [],
          visibleTurnItems: [reference],
        },
      });
      const snapshot = yield* fetchEnvironmentThreadSnapshot({
        prepared: PREPARED,
        threadId: v2ThreadId,
        signer: Option.none(),
      }).pipe(Effect.provide(harness.layer));
      expect(snapshot.projection.visibleTurnItems[0]!.item).toBe(snapshot.projection.turnItems[0]);
      expect(snapshot.projection.visibleTurnItems[0]!.item).toEqual(item);
      expect(snapshot.projection).not.toHaveProperty("payloadFormat");
    }),
  );

  it.effect(
    "fetches complete output on demand with an environment-scoped relay proof and opaque item id",
    () =>
      Effect.gen(function* () {
        const calls: URL[] = [];
        const proofs: ManagedRelayDpopProofInput[] = [];
        const signer = ManagedRelayDpopSigner.of({
          thumbprint: Effect.succeed("test-thumbprint"),
          createProof: (input) =>
            Effect.sync(() => {
              proofs.push(input);
              return "test-proof";
            }),
        });
        const fetchFn: typeof fetch = (request, init) => {
          calls.push(new URL(String(request)));
          expect(new Headers(init?.headers).get("authorization")).toBe("DPoP test-access");
          expect(new Headers(init?.headers).get("dpop")).toBe("test-proof");
          return Promise.resolve(
            Response.json({ text: "complete output", totalBytes: 15, format: "text" }),
          );
        };
        const itemId = TurnItemId.make("item:opaque/+?&=id");
        const output = yield* fetchEnvironmentToolOutput({
          prepared: {
            ...PREPARED,
            httpAuthorization: { _tag: "Dpop", accessToken: "test-access" },
          },
          threadId: v2ThreadId,
          itemId,
        }).pipe(
          Effect.provideService(ManagedRelayDpopSigner, signer),
          Effect.provide(remoteHttpClientLayer(fetchFn)),
        );
        expect(output.text).toBe("complete output");
        expect(calls).toHaveLength(1);
        expect(calls[0]!.pathname).toBe(
          `/api/orchestration/threads/${encodeURIComponent(v2ThreadId)}/items/${encodeURIComponent(itemId)}/output`,
        );
        expect(proofs).toEqual([
          { method: "GET", url: calls[0]!.href, accessToken: "test-access" },
        ]);
      }),
  );

  it.effect(
    "requests a bounded latest page with local session credentials and decodes its index",
    () =>
      Effect.gen(function* () {
        const harness = httpHarness();
        const snapshot = yield* fetchEnvironmentThreadSnapshot({
          prepared: PREPARED,
          threadId: v2ThreadId,
          signer: Option.none(),
          history: { limit: 50 },
        }).pipe(Effect.provide(harness.layer));

        expect(snapshot).toEqual(SNAPSHOT);
        expect(harness.calls).toHaveLength(1);
        const { url, init } = harness.calls[0]!;
        expect(url.origin).toBe("https://environment.example.test");
        expect(url.pathname).toBe(`/api/orchestration/threads/${v2ThreadId}`);
        expect([...url.searchParams]).toEqual([
          ["limit", "50"],
          ["payloadFormat", "compact-v1"],
        ]);
        expect(init.method).toBe("GET");
        expect(init.credentials).toBe("include");
      }),
  );

  it.effect("preserves an opaque older-page cursor on a bearer-authenticated remote request", () =>
    Effect.gen(function* () {
      const harness = httpHarness();
      const before = TurnItemId.make("item:older/+?&=cursor");
      yield* fetchEnvironmentThreadSnapshot({
        prepared: { ...PREPARED, httpAuthorization: { _tag: "Bearer", token: "test-token" } },
        threadId: v2ThreadId,
        signer: Option.none(),
        history: { limit: 25, before },
      }).pipe(Effect.provide(harness.layer));

      const { url, init } = harness.calls[0]!;
      expect(url.searchParams.get("before")).toBe(before);
      expect(url.searchParams.get("limit")).toBe("25");
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer test-token");
      expect(init.credentials).not.toBe("include");
    }),
  );

  it.effect("binds a relay index jump to the requested environment and message", () =>
    Effect.gen(function* () {
      const harness = httpHarness();
      const proofs: ManagedRelayDpopProofInput[] = [];
      const signer = ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("test-thumbprint"),
        createProof: (input) =>
          Effect.sync(() => {
            proofs.push(input);
            return "test-proof";
          }),
      });
      const around = MessageId.make("message:earlier/+?&=target");
      yield* fetchEnvironmentThreadSnapshot({
        prepared: { ...PREPARED, httpAuthorization: { _tag: "Dpop", accessToken: "test-access" } },
        threadId: v2ThreadId,
        signer: Option.some(signer),
        history: { limit: 50, around },
      }).pipe(Effect.provide(harness.layer));

      const { url, init } = harness.calls[0]!;
      expect(url.searchParams.get("around")).toBe(around);
      expect(proofs).toEqual([{ method: "GET", url: url.href, accessToken: "test-access" }]);
      expect(new Headers(init.headers).get("authorization")).toBe("DPoP test-access");
      expect(new Headers(init.headers).get("dpop")).toBe("test-proof");
    }),
  );

  it.effect("keeps full snapshot requests compatible when pagination is not supported", () =>
    Effect.gen(function* () {
      const legacySnapshot = { snapshotSequence: 7, projection: v2Projection };
      const harness = httpHarness(legacySnapshot);
      const snapshot = yield* fetchEnvironmentThreadSnapshot({
        prepared: PREPARED,
        threadId: v2ThreadId,
        signer: Option.none(),
      }).pipe(Effect.provide(harness.layer));

      expect(snapshot).toEqual(legacySnapshot);
      expect(harness.calls[0]!.url.searchParams.get("payloadFormat")).toBe("compact-v1");
    }),
  );
});
