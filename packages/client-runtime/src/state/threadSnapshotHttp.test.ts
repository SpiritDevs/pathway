import {
  EnvironmentId,
  MessageId,
  OrchestrationV2ThreadDetailSnapshot,
  TurnItemId,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { ManagedRelayDpopSigner, type ManagedRelayDpopProofInput } from "../relay/managedRelay.ts";
import { v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";
import { fetchEnvironmentThreadSnapshot } from "./threadSnapshotHttp.ts";

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
const encodeSnapshot = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ThreadDetailSnapshot));

function httpHarness(snapshot = SNAPSHOT) {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const fetchFn: typeof fetch = (request, init) => {
    calls.push({ url: new URL(String(request)), init: init ?? {} });
    return Promise.resolve(Response.json(encodeSnapshot(snapshot)));
  };
  return { calls, layer: remoteHttpClientLayer(fetchFn) };
}

describe("thread history HTTP requests", () => {
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
        expect([...url.searchParams]).toEqual([["limit", "50"]]);
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
      expect(harness.calls[0]!.url.search).toBe("");
    }),
  );
});
