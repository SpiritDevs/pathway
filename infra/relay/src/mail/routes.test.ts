import { verifyToken } from "@clerk/backend";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { RelayConfiguration } from "../Config.ts";
import { encodeBase64Url, oauthBrowserCookie } from "./crypto.ts";
import { ConnectedMail, mailRoutes } from "./routes.ts";
import { makeMailRuntime } from "./runtime.ts";

vi.mock("@clerk/backend", () => ({ verifyToken: vi.fn() }));

const origin = "https://relay.spiritdevs.com";
const authorizationUrl = "https://accounts.google.com/o/oauth2/v2/auth?state=state";
const config = {
  encryptionKey: Redacted.make(encodeBase64Url(new Uint8Array(32).fill(7))),
  uploadThingApiKey: Redacted.make("storage"),
  pubsubTopic: "",
  pubsubServiceAccount: "",
  hostedClientId: "hosted",
  hostedClientSecret: Redacted.make("secret"),
};

function fixture() {
  const runtime = makeMailRuntime({
    config,
    origin,
    rpc: {
      query: async () => {
        throw new Error("Unexpected query");
      },
      mutation: async () => {
        throw new Error("Unexpected mutation");
      },
    },
    enqueue: async () => {},
  });
  const start = vi.spyOn(runtime, "startOAuth").mockResolvedValue({ authorizationUrl });
  const finish = vi.spyOn(runtime, "finishOAuth").mockResolvedValue({ id: "account" });
  const dependencies = Layer.mergeAll(
    Layer.succeed(ConnectedMail, { runtime, config }),
    Layer.succeed(RelayConfiguration, {
      relayIssuer: origin,
      apns: undefined,
      clerkSecretKey: Redacted.make("clerk-secret"),
      clerkPublishableKey: "pk_test_test",
      clerkJwtAudience: "pathway-relay",
      apnsDeliveryJobSigningSecret: Redacted.make("apns"),
      cloudMintPrivateKey: Redacted.make("mint"),
      cloudMintPublicKey: "public",
      managedEndpointBaseDomain: undefined,
      managedEndpointNamespace: undefined,
    }),
  );
  return {
    start,
    finish,
    ...HttpRouter.toWebHandler(mailRoutes, {
      disableLogger: true,
      middleware: (effect) => effect.pipe(Effect.provide(dependencies)),
    }),
  };
}

beforeEach(() => {
  vi.mocked(verifyToken).mockReset();
  vi.mocked(verifyToken).mockResolvedValue({ sub: "owner" } as never);
});

it.each(["byo", "hosted"])(
  "starts %s OAuth in a top-level popup without an existing cookie",
  async (credentialSource) => {
    const f = fixture();
    try {
      const response = await f.handler(
        new Request(`${origin}/v1/mail/oauth/start`, {
          method: "POST",
          headers: {
            Origin: "https://app.pathwayos.dev",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Dest": "document",
          },
          body: new URLSearchParams({
            accessToken: "session",
            companyId: "company",
            credentialSource,
            clientId: "client",
            clientSecret: "secret",
          }),
        }),
      );
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(authorizationUrl);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      const cookie = await oauthBrowserCookie("state");
      expect(response.headers.get("set-cookie")).toBe(
        `${cookie.name}=${cookie.value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`,
      );
      expect(verifyToken).toHaveBeenCalledWith("session", {
        secretKey: "clerk-secret",
        audience: "pathway-relay",
      });
      expect(f.start).toHaveBeenCalledWith({
        ownerSubject: "owner",
        companyId: "company",
        credentialSource,
        ...(credentialSource === "byo" ? { clientId: "client", clientSecret: "secret" } : {}),
      });

      const callback = await f.handler(
        new Request(`${origin}/v1/mail/oauth/callback?state=state&code=code`, {
          headers: { Cookie: `${cookie.name}=${cookie.value}` },
        }),
      );
      expect(callback.status).toBe(200);
      expect(f.finish).toHaveBeenCalledWith("state", "code");
      expect(callback.headers.get("set-cookie")).toContain("Max-Age=0");
    } finally {
      await f.dispose();
    }
  },
);

it("rejects an invalid form token before creating state or setting a cookie", async () => {
  vi.mocked(verifyToken).mockRejectedValue(new Error("Invalid token"));
  const f = fixture();
  try {
    const response = await f.handler(
      new Request(`${origin}/v1/mail/oauth/start`, {
        method: "POST",
        body: new URLSearchParams({
          accessToken: "invalid",
          companyId: "company",
          credentialSource: "hosted",
        }),
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(f.start).not.toHaveBeenCalled();
  } finally {
    await f.dispose();
  }
});

it.each([undefined, "wrong=value"])(
  "still rejects callbacks without the matching browser cookie (%s)",
  async (cookie) => {
    const f = fixture();
    try {
      const response = await f.handler(
        new Request(`${origin}/v1/mail/oauth/callback?state=state&code=code`, {
          headers: cookie ? { Cookie: cookie } : {},
        }),
      );
      expect(response.status).toBe(400);
      expect(f.finish).not.toHaveBeenCalled();
    } finally {
      await f.dispose();
    }
  },
);

it("preserves the JSON start response for previously released clients", async () => {
  const f = fixture();
  try {
    const response = await f.handler(
      new Request(`${origin}/v1/mail/oauth/start`, {
        method: "POST",
        headers: { Authorization: "Bearer session", "Content-Type": "application/json" },
        body: JSON.stringify({ companyId: "company", credentialSource: "hosted" }),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ authorizationUrl });
    expect(response.headers.get("set-cookie")).toContain("SameSite=None");
  } finally {
    await f.dispose();
  }
});
