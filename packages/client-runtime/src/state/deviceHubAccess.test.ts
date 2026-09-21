import { expect, it } from "@effect/vitest";
import { EnvironmentId } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { ManagedRelayDpopSigner, type ManagedRelayDpopProofInput } from "../relay/managedRelay.ts";
import { resolveDeviceHubAccess } from "./deviceHubAccess.ts";

const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("test"),
  label: "Test",
  httpBaseUrl: "https://device.test/environment/",
  wsBaseUrl: "wss://device.test/environment/",
});
const prepared: PreparedConnection = {
  environmentId: target.environmentId,
  label: target.label,
  target,
  httpBaseUrl: target.httpBaseUrl,
  socketUrl: target.wsBaseUrl + "ws",
  httpAuthorization: null,
};

it.effect("uses session cookies without minting tickets for the local client", () =>
  Effect.gen(function* () {
    const access = yield* resolveDeviceHubAccess({ prepared, hubBasePath: "/api/device-hub" });
    expect(access).toEqual({
      httpBase: "https://device.test/api/device-hub",
      wsBase: "wss://device.test/api/device-hub",
      credentials: true,
      query: {},
    });
  }).pipe(
    Effect.provide(remoteHttpClientLayer(() => Promise.reject(new Error("No HTTP expected")))),
  ),
);

it.effect("mints a media ticket with the remote credential and uses the environment origin", () =>
  Effect.gen(function* () {
    const access = yield* resolveDeviceHubAccess({
      prepared: { ...prepared, httpAuthorization: { _tag: "Bearer", token: "test-credential" } },
      hubBasePath: "/api/device-hub",
    });
    expect(access.query).toEqual({ wsTicket: "test-ticket" });
    expect(access.credentials).toBe(false);
  }).pipe(
    Effect.provide(
      remoteHttpClientLayer(async (input, init) => {
        const request = new Request(input, init);
        expect(request.url).toBe("https://device.test/api/auth/websocket-ticket");
        expect(request.headers.get("authorization")).toBe("Bearer test-credential");
        return Response.json({ ticket: "test-ticket", expiresAt: "2026-09-22T00:00:00.000Z" });
      }),
    ),
  ),
);

it.effect("binds the relay media ticket proof to the token and ticket endpoint", () =>
  Effect.gen(function* () {
    const proofs: ManagedRelayDpopProofInput[] = [];
    const access = yield* resolveDeviceHubAccess({
      prepared: { ...prepared, httpAuthorization: { _tag: "Dpop", accessToken: "relay-access" } },
      hubBasePath: "/api/device-hub",
    }).pipe(
      Effect.provideService(
        ManagedRelayDpopSigner,
        ManagedRelayDpopSigner.of({
          thumbprint: Effect.succeed("thumbprint"),
          createProof: (input) =>
            Effect.sync(() => {
              proofs.push(input);
              return "relay-proof";
            }),
        }),
      ),
      Effect.provide(
        remoteHttpClientLayer(async (input, init) => {
          const request = new Request(input, init);
          expect(request.headers.get("authorization")).toBe("DPoP relay-access");
          expect(request.headers.get("dpop")).toBe("relay-proof");
          return Response.json({ ticket: "relay-ticket", expiresAt: "2026-09-22T00:00:00.000Z" });
        }),
      ),
    );
    expect(proofs).toEqual([
      {
        method: "POST",
        url: "https://device.test/api/auth/websocket-ticket",
        accessToken: "relay-access",
      },
    ]);
    expect(access.query).toEqual({ wsTicket: "relay-ticket" });
    expect(access.credentials).toBe(false);
  }),
);
