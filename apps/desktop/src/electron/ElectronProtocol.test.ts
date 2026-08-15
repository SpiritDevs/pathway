import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";

const {
  handleMock,
  netFetchMock,
  onBeforeSendHeadersMock,
  onCompletedMock,
  onErrorOccurredMock,
  onHeadersReceivedMock,
  unhandleMock,
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  netFetchMock: vi.fn(),
  onBeforeSendHeadersMock: vi.fn(),
  onCompletedMock: vi.fn(),
  onErrorOccurredMock: vi.fn(),
  onHeadersReceivedMock: vi.fn(),
  unhandleMock: vi.fn(),
}));

vi.mock("electron", () => ({
  net: { fetch: netFetchMock },
  protocol: { handle: handleMock, unhandle: unhandleMock },
  session: {
    defaultSession: {
      webRequest: {
        onBeforeSendHeaders: onBeforeSendHeadersMock,
        onCompleted: onCompletedMock,
        onErrorOccurred: onErrorOccurredMock,
        onHeadersReceived: onHeadersReceivedMock,
      },
    },
  },
}));

import * as ElectronProtocol from "./ElectronProtocol.ts";

describe("ElectronProtocol", () => {
  beforeEach(() => {
    handleMock.mockReset();
    netFetchMock.mockReset();
    onBeforeSendHeadersMock.mockReset();
    onCompletedMock.mockReset();
    onErrorOccurredMock.mockReset();
    onHeadersReceivedMock.mockReset();
    unhandleMock.mockReset();
  });

  it("removes Chromium's desktop origin from native Clerk requests", () => {
    const authenticatedHeaders = {
      Accept: "application/json",
      Authorization: "Bearer client-jwt",
      Origin: "pathway://app",
    };

    assert.deepEqual(
      ElectronProtocol.prepareDesktopClerkRequestHeaders(authenticatedHeaders, "pathway://app"),
      {
        Accept: "application/json",
        Authorization: "Bearer client-jwt",
      },
    );
    assert.deepEqual(
      ElectronProtocol.prepareDesktopClerkRequestHeaders(
        {
          Accept: "application/json",
          Origin: "pathway://app",
        },
        "pathway://app",
      ),
      { Accept: "application/json" },
    );
    assert.deepEqual(
      ElectronProtocol.prepareDesktopClerkRequestHeaders(
        {
          Accept: "*/*",
          "Access-Control-Request-Headers": "authorization",
          "Access-Control-Request-Method": "GET",
          Origin: "pathway://app",
        },
        "pathway://app",
      ),
      {
        Accept: "*/*",
        "Access-Control-Request-Headers": "authorization",
        "Access-Control-Request-Method": "GET",
      },
    );
    assert.deepEqual(
      ElectronProtocol.prepareDesktopClerkRequestHeaders(authenticatedHeaders, "pathway-dev://app"),
      authenticatedHeaders,
    );
    assert.deepEqual(authenticatedHeaders, {
      Accept: "application/json",
      Authorization: "Bearer client-jwt",
      Origin: "pathway://app",
    });
  });

  it("allows the trusted desktop origin to read native Clerk responses", () => {
    assert.deepEqual(
      ElectronProtocol.prepareDesktopClerkResponseHeaders(
        {
          "content-type": ["application/json"],
          "access-control-allow-origin": ["https://unexpected.example"],
          "access-control-allow-headers": ["x-unexpected"],
          "access-control-allow-methods": ["POST"],
        },
        {
          origin: "pathway://app",
          requestedHeaders: "authorization",
          requestedMethod: "GET",
        },
      ),
      {
        "content-type": ["application/json"],
        "Access-Control-Allow-Origin": ["pathway://app"],
        "Access-Control-Allow-Headers": ["authorization"],
        "Access-Control-Allow-Methods": ["GET"],
      },
    );
  });

  it.effect("proxies the stable renderer origin to the current app server", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockResolvedValue(new Response("ok"));

      yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "pathway-dev",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3774/"),
            clerkFrontendApiHostname: "clerk.t3.codes",
          });
          assert.isDefined(handler);

          const response = yield* Effect.promise(() =>
            handler!(
              new Request("pathway-dev://app/api/health?verbose=1", {
                headers: {
                  accept: "application/json",
                  origin: "pathway-dev://app",
                  referer: "pathway-dev://app/",
                  "sec-fetch-site": "same-origin",
                },
              }),
            ),
          );
          assert.equal(yield* Effect.promise(() => response.text()), "ok");
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://clerk.t3.codes https://challenges.cloudflare.com",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "connect-src 'self' http: https: ws: wss:",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "img-src 'self' pathway-dev: blob: data: http: https:",
          );
          assert.include(
            response.headers.get("content-security-policy") ?? "",
            "font-src 'self' pathway-dev: data:",
          );
        }),
      );

      assert.deepEqual(
        handleMock.mock.calls.map((call) => call[0]),
        ["pathway-dev"],
      );
      assert.equal(netFetchMock.mock.calls[0]?.[0], "http://127.0.0.1:3773/api/health?verbose=1");
      const forwardedHeaders = new Headers(netFetchMock.mock.calls[0]?.[1]?.headers);
      assert.equal(forwardedHeaders.get("accept"), "application/json");
      assert.isNull(forwardedHeaders.get("origin"));
      assert.isNull(forwardedHeaders.get("referer"));
      assert.isNull(forwardedHeaders.get("sec-fetch-site"));
      assert.deepEqual(unhandleMock.mock.calls, [["pathway-dev"]]);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("rejects custom protocol requests for another host", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "pathway",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
          });
          return yield* Effect.promise(() => handler!(new Request("pathway://other/")));
        }),
      );

      assert.equal(response.status, 404);
      assert.equal(netFetchMock.mock.calls.length, 0);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("retries transient renderer target failures", () =>
    Effect.gen(function* () {
      let handler: ((request: Request) => Promise<Response>) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock
        .mockRejectedValueOnce(new Error("connect ECONNREFUSED 127.0.0.1:5733"))
        .mockResolvedValueOnce(new Response("ready"));

      const response = yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "pathway-dev",
            targetOrigin: new URL("http://127.0.0.1:5733/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
          });
          return yield* Effect.promise(() => handler!(new Request("pathway-dev://app/")));
        }),
      );

      assert.equal(yield* Effect.promise(() => response.text()), "ready");
      assert.equal(netFetchMock.mock.calls.length, 2);
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("preserves protocol registration failures", () =>
    Effect.gen(function* () {
      const cause = new Error("protocol registration failed");
      handleMock.mockImplementationOnce(() => {
        throw cause;
      });

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      const error = yield* Effect.scoped(
        protocol.registerDesktopProtocol({
          scheme: "pathway-dev",
          targetOrigin: new URL("http://127.0.0.1:3773/"),
          backendOrigin: new URL("http://127.0.0.1:3774/"),
          clerkFrontendApiHostname: undefined,
        }),
      ).pipe(Effect.flip);

      assert.instanceOf(error, ElectronProtocol.ElectronProtocolRegistrationError);
      assert.equal(error.scheme, "pathway-dev");
      assert.strictEqual(error.cause, cause);
      assert.equal(error.message, 'Failed to register Electron protocol scheme "pathway-dev".');
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it.effect("preserves protocol unregistration failures", () =>
    Effect.gen(function* () {
      const cause = new Error("protocol unregistration failed");
      unhandleMock.mockImplementationOnce(() => {
        throw cause;
      });

      const protocol = yield* ElectronProtocol.ElectronProtocol;
      const exit = yield* Effect.exit(
        Effect.scoped(
          protocol.registerDesktopProtocol({
            scheme: "pathway",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
          }),
        ),
      );

      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        const error = Cause.squash(exit.cause);
        assert.instanceOf(error, ElectronProtocol.ElectronProtocolUnregistrationError);
        assert.equal(error.scheme, "pathway");
        assert.strictEqual(error.cause, cause);
        assert.equal(error.message, 'Failed to unregister Electron protocol scheme "pathway".');
      }
    }).pipe(Effect.provide(ElectronProtocol.layer)),
  );

  it("keeps executable sources host-restricted while allowing runtime network resources", () => {
    const policy = ElectronProtocol.makeDesktopContentSecurityPolicy({
      scheme: "pathway",
      targetOrigin: new URL("http://127.0.0.1:3773/"),
      backendOrigin: new URL("http://127.0.0.1:3773/"),
      clerkFrontendApiHostname: "clerk.t3.codes",
    });
    const directives = Object.fromEntries(
      policy.split("; ").map((directive) => {
        const [name, ...sources] = directive.split(" ");
        return [name, sources];
      }),
    );

    assert.deepEqual(directives["script-src"], [
      "'self'",
      "'unsafe-inline'",
      "'wasm-unsafe-eval'",
      "https://clerk.t3.codes",
      "https://challenges.cloudflare.com",
    ]);
    assert.deepEqual(directives["connect-src"], ["'self'", "http:", "https:", "ws:", "wss:"]);
    assert.deepEqual(directives["img-src"], [
      "'self'",
      "pathway:",
      "blob:",
      "data:",
      "http:",
      "https:",
    ]);
    assert.deepEqual(directives["font-src"], ["'self'", "pathway:", "data:"]);
  });
});
