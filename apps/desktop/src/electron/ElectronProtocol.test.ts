import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import { beforeEach, vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as Path from "effect/Path";
import * as NodeURL from "node:url";

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
  const bundledRendererFixture = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pathway-ui-" });
    yield* fs.makeDirectory(path.join(directory, "assets"));
    yield* fs.writeFileString(path.join(directory, "index.html"), "<main>Pathway</main>");
    yield* fs.writeFileString(path.join(directory, "assets/app.js"), "export {}");
    yield* fs.writeFileString(path.join(directory, "assets/app theme.css"), "body {}");
    return directory;
  });
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
            clerkFrontendApiHostname: "clerk.spiritdevs.com",
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
            "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' https://clerk.spiritdevs.com https://challenges.cloudflare.com",
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
    }).pipe(Effect.provide(ElectronProtocol.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
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
    }).pipe(Effect.provide(ElectronProtocol.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  );

  it.effect("loads the packaged shell and assets without an available backend", () =>
    Effect.gen(function* () {
      const bundledRendererDirectory = yield* bundledRendererFixture;
      let handler: ((request: Request) => Promise<Response> | Response) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockImplementation(async (url: string, init: RequestInit) => {
        if (!url.startsWith("file:")) throw new Error("Backend is still starting");
        const contents = url.endsWith("index.html")
          ? "<main>Pathway</main>"
          : url.endsWith("app.js")
            ? "export {}"
            : "body {}";
        return new Response(init.method === "HEAD" ? null : contents);
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "pathway",
            targetOrigin: new URL("http://127.0.0.1:3773/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
            bundledRendererDirectory,
          });
          for (const [pathname, file, body] of [
            ["/", "index.html", "<main>Pathway</main>"],
            ["/threads/123?tab=changes", "index.html", "<main>Pathway</main>"],
            ["/assets/app.js?v=1", "assets/app.js", "export {}"],
            ["/assets/app%20theme.css", "assets/app theme.css", "body {}"],
          ]) {
            const response = yield* Effect.promise(async () =>
              handler!(new Request(`pathway://app${pathname}`)),
            );
            assert.equal(response.status, 200);
            assert.equal(yield* Effect.promise(() => response.text()), body);
            assert.include(
              response.headers.get("content-security-policy") ?? "",
              "default-src 'self'",
            );
            assert.equal(
              netFetchMock.mock.lastCall?.[0],
              NodeURL.pathToFileURL(`${bundledRendererDirectory}/${file}`).href,
            );
          }
          const head = yield* Effect.promise(async () =>
            handler!(new Request("pathway://app/assets/app.js", { method: "HEAD" })),
          );
          assert.equal(head.status, 200);
          assert.equal(yield* Effect.promise(() => head.text()), "");
        }),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(ElectronProtocol.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
  );

  it.effect("keeps API, auth, discovery and websocket paths on the backend", () =>
    Effect.gen(function* () {
      const bundledRendererDirectory = yield* bundledRendererFixture;
      let handler: ((request: Request) => Promise<Response> | Response) | undefined;
      handleMock.mockImplementation((_scheme, nextHandler) => {
        handler = nextHandler;
      });
      netFetchMock.mockImplementation(async () => new Response("Starting", { status: 503 }));
      yield* Effect.scoped(
        Effect.gen(function* () {
          const protocol = yield* ElectronProtocol.ElectronProtocol;
          yield* protocol.registerDesktopProtocol({
            scheme: "pathway",
            targetOrigin: new URL("http://127.0.0.1:3772/"),
            backendOrigin: new URL("http://127.0.0.1:3773/"),
            clerkFrontendApiHostname: undefined,
            bundledRendererDirectory,
          });
          for (const pathname of [
            "/api",
            "/api/auth/session",
            "/oauth/callback",
            "/.well-known/pathway/shell",
            "/ws",
          ]) {
            const response = yield* Effect.promise(async () =>
              handler!(new Request(`pathway://app${pathname}`)),
            );
            assert.equal(response.status, 503);
            assert.equal(netFetchMock.mock.lastCall?.[0], `http://127.0.0.1:3773${pathname}`);
          }
          const response = yield* Effect.promise(async () =>
            handler!(
              new Request("pathway://app/api/auth/bootstrap", {
                method: "POST",
                body: "credential",
              }),
            ),
          );
          assert.equal(response.status, 503);
          assert.equal(netFetchMock.mock.lastCall?.[1].method, "POST");
          assert.equal(
            yield* Effect.promise(() => new Response(netFetchMock.mock.lastCall?.[1].body).text()),
            "credential",
          );
        }),
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(ElectronProtocol.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    ),
  );

  it.effect(
    "rejects invalid paths, missing assets and writes without falling back to the backend",
    () =>
      Effect.gen(function* () {
        const bundledRendererDirectory = yield* bundledRendererFixture;
        let handler: ((request: Request) => Promise<Response> | Response) | undefined;
        handleMock.mockImplementation((_scheme, nextHandler) => {
          handler = nextHandler;
        });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const protocol = yield* ElectronProtocol.ElectronProtocol;
            yield* protocol.registerDesktopProtocol({
              scheme: "pathway",
              targetOrigin: new URL("http://127.0.0.1:3773/"),
              backendOrigin: new URL("http://127.0.0.1:3773/"),
              clerkFrontendApiHostname: undefined,
              bundledRendererDirectory,
            });
            for (const [url, status] of [
              ["pathway://other/", 404],
              ["pathway://app/assets/missing.js", 404],
              ["pathway://app/..%2fsecret.txt", 400],
              ["pathway://app/..%5csecret.txt", 400],
              ["pathway://app/%00secret", 400],
              ["pathway://app/%zz", 400],
            ] as const) {
              const response = yield* Effect.promise(async () => handler!(new Request(url)));
              assert.equal(response.status, status);
            }
            const response = yield* Effect.promise(async () =>
              handler!(new Request("pathway://app/", { method: "POST" })),
            );
            assert.equal(response.status, 405);
            assert.equal(netFetchMock.mock.calls.length, 0);
          }),
        );
      }).pipe(
        Effect.scoped,
        Effect.provide(ElectronProtocol.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      ),
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
    }).pipe(Effect.provide(ElectronProtocol.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
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
    }).pipe(Effect.provide(ElectronProtocol.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
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
    }).pipe(Effect.provide(ElectronProtocol.layer.pipe(Layer.provideMerge(NodeServices.layer)))),
  );

  it("keeps executable sources host-restricted while allowing runtime network resources", () => {
    const policy = ElectronProtocol.makeDesktopContentSecurityPolicy({
      scheme: "pathway",
      targetOrigin: new URL("http://127.0.0.1:3773/"),
      backendOrigin: new URL("http://127.0.0.1:3773/"),
      clerkFrontendApiHostname: "clerk.spiritdevs.com",
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
      "https://clerk.spiritdevs.com",
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
