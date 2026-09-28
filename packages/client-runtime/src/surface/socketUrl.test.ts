import { describe, expect, it } from "@effect/vitest";
import { PreviewTabId, ThreadId, EnvironmentId } from "@spiritdevs/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { PrimaryConnectionTarget, type PreparedConnection } from "../connection/model.ts";
import { remoteHttpClientLayer } from "../rpc/http.ts";
import { resolveSurfaceSocketUrl } from "./socketUrl.ts";

const target = {
  kind: "browser" as const,
  threadId: ThreadId.make("thread"),
  tabId: PreviewTabId.make("tab"),
};
const viewport = { width: 800, height: 600, deviceScale: 2 };
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

describe("resolveSurfaceSocketUrl", () => {
  it.effect("keeps cookie-authenticated primary connections ticketless", () =>
    Effect.gen(function* () {
      const fetch = ticketFetch("unused");
      const resolved = yield* resolveSurfaceSocketUrl({
        prepared: prepared("ws://127.0.0.1:4321/ws", null),
        target,
        viewport,
        signer: Option.none(),
      }).pipe(Effect.provide(remoteHttpClientLayer(fetch.fetchFn)));

      expect(resolved).toEqual({
        url: "ws://127.0.0.1:4321/ws/environment-surface?kind=browser&threadId=thread&tabId=tab&width=800&height=600&deviceScale=2",
        expiresAt: null,
      });
      expect(fetch.calls).toHaveLength(0);
    }),
  );

  it.effect("mints a fresh bearer ticket for the frame route, with its expiry", () =>
    Effect.gen(function* () {
      const fetch = ticketFetch("frame-ticket");
      const { url, expiresAt } = yield* resolveSurfaceSocketUrl({
        prepared: prepared("wss://remote.example.com/ws?wsTicket=used", {
          _tag: "Bearer",
          token: "bearer-token",
        }),
        target,
        viewport,
        signer: Option.none(),
      }).pipe(Effect.provide(remoteHttpClientLayer(fetch.fetchFn)));

      const parsed = new URL(url);
      expect(parsed.pathname).toBe("/ws/environment-surface");
      expect(parsed.searchParams.get("tabId")).toBe("tab");
      expect(parsed.searchParams.get("wsTicket")).toBe("frame-ticket");
      expect(expiresAt).toBe(Date.parse("2026-05-01T12:05:00.000Z"));
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
      const { url, expiresAt } = yield* resolveSurfaceSocketUrl({
        prepared: prepared("wss://remote.example.com/ws?wsTicket=used", {
          _tag: "Dpop",
          accessToken: "access-token",
        }),
        target,
        viewport,
        signer: Option.some({
          thumbprint: Effect.succeed("thumbprint"),
          createProof: (input) => {
            proofs.push(input);
            return Effect.succeed("proof");
          },
        }),
      }).pipe(Effect.provide(remoteHttpClientLayer(fetch.fetchFn)));

      expect(new URL(url).searchParams.get("wsTicket")).toBe("relay-ticket");
      expect(expiresAt).toBe(Date.parse("2026-05-01T12:05:00.000Z"));
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
      const error = yield* resolveSurfaceSocketUrl({
        prepared: prepared("wss://remote.example.com/ws", { _tag: "Dpop", accessToken: "a" }),
        target,
        viewport,
        signer: Option.none(),
      }).pipe(Effect.provide(remoteHttpClientLayer(fetch.fetchFn)), Effect.flip);

      expect(error._tag).toBe("RemoteEnvironmentAuthFetchError");
      expect(fetch.calls).toHaveLength(0);
    }),
  );
});
