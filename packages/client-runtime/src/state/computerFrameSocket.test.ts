import { describe, expect, it } from "@effect/vitest";
import { ComputerId, EnvironmentId } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import {
  computerFrameSocketBaseUrl,
  resolveComputerFrameSocketUrl,
} from "./computerFrameSocket.ts";

const COMPUTER_ID = ComputerId.make("desktop");
const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

type FetchCall = readonly [input: RequestInfo | URL, init: RequestInit];

const ticketFetch = (ticket: string) => {
  const calls: Array<FetchCall> = [];
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    return Promise.resolve(
      Response.json({ ticket, expiresAt: "2026-05-01T12:05:00.000Z" }, { status: 200 }),
    );
  }) satisfies typeof fetch;
  return { fetchFn, calls };
};

function prepared(
  socketUrl: string,
  httpAuthorization: PreparedConnection["httpAuthorization"],
): PreparedConnection {
  return {
    environmentId: ENVIRONMENT_ID,
    label: "Remote",
    httpBaseUrl: "https://remote.example.com/",
    socketUrl,
    httpAuthorization,
    target: new PrimaryConnectionTarget({
      environmentId: ENVIRONMENT_ID,
      label: "Remote",
      httpBaseUrl: "https://remote.example.com/",
      wsBaseUrl: "wss://remote.example.com/",
    }),
  };
}

describe("computerFrameSocketBaseUrl", () => {
  it("swaps the rpc route for the frame route and drops the consumed ticket", () => {
    expect(computerFrameSocketBaseUrl("wss://remote.example.com/ws?wsTicket=used")).toBe(
      "wss://remote.example.com/ws/computer-frames",
    );
    expect(computerFrameSocketBaseUrl("ws://127.0.0.1:4321/")).toBe(
      "ws://127.0.0.1:4321/ws/computer-frames",
    );
    expect(computerFrameSocketBaseUrl("wss://proxy.example.com/pathway/ws")).toBe(
      "wss://proxy.example.com/pathway/ws/computer-frames",
    );
  });
});

describe("resolveComputerFrameSocketUrl", () => {
  it.effect("keeps cookie-authenticated primary connections ticketless", () =>
    Effect.gen(function* () {
      const fetch = ticketFetch("unused");
      const url = yield* resolveComputerFrameSocketUrl({
        prepared: prepared("ws://127.0.0.1:4321/ws", null),
        computerId: COMPUTER_ID,
        signer: Option.none(),
      }).pipe(Effect.provide(remoteHttpClientLayer(fetch.fetchFn)));

      expect(url).toBe("ws://127.0.0.1:4321/ws/computer-frames?computerId=desktop");
      expect(fetch.calls).toHaveLength(0);
    }),
  );

  it.effect("mints a fresh bearer ticket for the frame route", () =>
    Effect.gen(function* () {
      const fetch = ticketFetch("frame-ticket");
      const url = yield* resolveComputerFrameSocketUrl({
        prepared: prepared("wss://remote.example.com/ws?wsTicket=used", {
          _tag: "Bearer",
          token: "bearer-token",
        }),
        computerId: COMPUTER_ID,
        signer: Option.none(),
      }).pipe(Effect.provide(remoteHttpClientLayer(fetch.fetchFn)));

      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/ws/computer-frames");
      expect(parsed.searchParams.get("computerId")).toBe("desktop");
      expect(parsed.searchParams.get("wsTicket")).toBe("frame-ticket");
      expect(String(fetch.calls[0]?.[0])).toBe(
        "https://remote.example.com/api/auth/websocket-ticket",
      );
      expect(fetch.calls[0]?.[1].headers).toEqual(
        expect.objectContaining({ authorization: "Bearer bearer-token" }),
      );
    }),
  );

  it.effect("signs the relay ticket request with a DPoP proof", () =>
    Effect.gen(function* () {
      const fetch = ticketFetch("relay-ticket");
      const proofs: Array<unknown> = [];
      const url = yield* resolveComputerFrameSocketUrl({
        prepared: prepared("wss://remote.example.com/ws?wsTicket=used", {
          _tag: "Dpop",
          accessToken: "access-token",
        }),
        computerId: COMPUTER_ID,
        signer: Option.some({
          thumbprint: Effect.succeed("thumbprint"),
          createProof: (input) => {
            proofs.push(input);
            return Effect.succeed("proof");
          },
        }),
      }).pipe(Effect.provide(remoteHttpClientLayer(fetch.fetchFn)));

      expect(new URL(url).searchParams.get("wsTicket")).toBe("relay-ticket");
      expect(proofs).toEqual([
        {
          method: "POST",
          url: "https://remote.example.com/api/auth/websocket-ticket",
          accessToken: "access-token",
        },
      ]);
      expect(fetch.calls[0]?.[1].headers).toEqual(
        expect.objectContaining({ authorization: "DPoP access-token", dpop: "proof" }),
      );
    }),
  );

  it.effect("fails a relay connection without a signer", () =>
    Effect.gen(function* () {
      const fetch = ticketFetch("unused");
      const error = yield* resolveComputerFrameSocketUrl({
        prepared: prepared("wss://remote.example.com/ws", { _tag: "Dpop", accessToken: "a" }),
        computerId: COMPUTER_ID,
        signer: Option.none(),
      }).pipe(Effect.provide(remoteHttpClientLayer(fetch.fetchFn)), Effect.flip);

      expect(error._tag).toBe("RemoteEnvironmentAuthFetchError");
      expect(fetch.calls).toHaveLength(0);
    }),
  );
});
