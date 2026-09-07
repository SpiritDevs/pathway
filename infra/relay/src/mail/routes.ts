import { verifyToken } from "@clerk/backend";
import { createRemoteJWKSet, jwtVerify } from "jose";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { RelayConfiguration } from "../Config.ts";
import type { MailRuntime } from "./runtime.ts";
import type { MailConfiguration } from "./config.ts";
import { decodeBase64Url, oauthBrowserCookie, hasOAuthBrowserCookie } from "./crypto.ts";

export class ConnectedMail extends Context.Service<
  ConnectedMail,
  { runtime: MailRuntime; config: MailConfiguration } | undefined
>()("pathway-relay/mail/routes/ConnectedMail") {}
const googleKeys = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
export async function verifyPubsubToken(
  token: string,
  audience: string,
  serviceAccount: string,
  keySet: Parameters<typeof jwtVerify>[1] = googleKeys,
) {
  const { payload } = await jwtVerify(token, keySet, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience,
    algorithms: ["RS256"],
  });
  if (payload.email !== serviceAccount || payload.email_verified !== true)
    throw new Error("Invalid Pub/Sub identity");
}
class MailHttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new MailHttpError(400, "Expected a JSON object");
  return value as Record<string, unknown>;
};
const required = (value: unknown, name: string, max = 1000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new MailHttpError(400, `Invalid ${name}`);
  return value;
};
async function json(request: Request) {
  const text = await request.text();
  if (text.length > 16_384) throw new MailHttpError(413, "Request too large");
  try {
    return record(JSON.parse(text));
  } catch (error) {
    if (error instanceof MailHttpError) throw error;
    throw new MailHttpError(400, "Invalid JSON");
  }
}
const decodeNotification = (data: string) =>
  record(JSON.parse(new TextDecoder().decode(decodeBase64Url(data))));
const mailHandler = Effect.gen(function* () {
  const service = yield* ConnectedMail;
  const config = yield* RelayConfiguration;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const webRequest = yield* HttpServerRequest.toWeb(request);
  return yield* Effect.promise(async () => {
    try {
      if (!service) throw new MailHttpError(503, "Connected email is not configured on this relay");
      const { runtime, config: mailConfig } = service;
      const url = new URL(webRequest.url);
      const path = url.pathname;
      if (path === "/v1/mail/oauth/callback") {
        if (url.searchParams.has("error"))
          throw new MailHttpError(
            400,
            "Google authorization was cancelled. Close this page and connect Gmail again.",
          );
        const state = required(url.searchParams.get("state"), "state");
        if (!(await hasOAuthBrowserCookie(state, webRequest.headers.get("cookie"))))
          throw new MailHttpError(
            400,
            "Open Email settings in the Pathway web app and start Gmail connection in this browser. The browser authorization state is missing.",
          );
        const browserCookie = await oauthBrowserCookie(state);
        await runtime.finishOAuth(state, required(url.searchParams.get("code"), "code", 4000));
        return HttpServerResponse.text(
          "<!doctype html><html><head><title>Gmail connected</title></head><body><h1>Gmail connected</h1><p>You can close this window and return to Pathway.</p></body></html>",
          {
            headers: {
              "content-type": "text/html; charset=utf-8",
              "cache-control": "no-store",
              "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
              "referrer-policy": "no-referrer",
              "set-cookie": `${browserCookie.name}=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0`,
            },
          },
        );
      }
      const bearer = webRequest.headers.get("authorization")?.match(/^Bearer (.+)$/)?.[1];
      if (!bearer) throw new MailHttpError(401, "Sign in to continue");
      if (path === "/v1/mail/notify") {
        try {
          await verifyPubsubToken(
            bearer,
            `${config.relayIssuer}/v1/mail/notify`,
            mailConfig.pubsubServiceAccount,
          );
        } catch {
          throw new MailHttpError(401, "Invalid notification identity");
        }
        const body = await json(webRequest);
        const message = record(body.message);
        let payload: Record<string, unknown>;
        try {
          payload = decodeNotification(required(message.data, "notification", 8192));
        } catch {
          throw new MailHttpError(400, "Invalid notification");
        }
        await runtime.notify(required(payload.emailAddress, "email", 320));
        return HttpServerResponse.empty({ status: 204 });
      }
      let ownerSubject: string;
      try {
        const claims = await verifyToken(bearer, {
          secretKey: Redacted.value(config.clerkSecretKey),
          audience: config.clerkJwtAudience,
        });
        ownerSubject = required(claims.sub, "identity");
      } catch {
        throw new MailHttpError(401, "Sign in to continue");
      }
      if (path === "/v1/mail/config")
        return HttpServerResponse.jsonUnsafe({
          enabled: true,
          hostedOAuthEnabled: Boolean(
            mailConfig.hostedClientId && Redacted.value(mailConfig.hostedClientSecret),
          ),
          redirectUri: `${config.relayIssuer}/v1/mail/oauth/callback`,
        });
      const body = await json(webRequest);
      const companyId = required(body.companyId, "company");
      if (path === "/v1/mail/oauth/start") {
        if (body.credentialSource !== "byo" && body.credentialSource !== "hosted")
          throw new MailHttpError(400, "Invalid credential source");
        const result = await runtime.startOAuth({
          ownerSubject,
          companyId,
          credentialSource: body.credentialSource,
          ...(body.credentialSource === "byo"
            ? {
                clientId: required(body.clientId, "client ID"),
                clientSecret: required(body.clientSecret, "client secret", 2000),
                ...(body.pubsubTopic
                  ? { pubsubTopic: required(body.pubsubTopic, "Pub/Sub topic") }
                  : {}),
              }
            : {}),
        });
        const state = new URL(result.authorizationUrl).searchParams.get("state")!;
        const browserCookie = await oauthBrowserCookie(state);
        return HttpServerResponse.jsonUnsafe(result, {
          headers: {
            "cache-control": "no-store",
            "set-cookie": `${browserCookie.name}=${browserCookie.value}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=600`,
          },
        });
      }
      if (path === "/v1/mail/wake") {
        await runtime.wake(ownerSubject, companyId, required(body.accountId, "account"));
        return HttpServerResponse.empty({ status: 204 });
      }
      if (path === "/v1/mail/disconnect") {
        await runtime.disconnect(ownerSubject, companyId, required(body.accountId, "account"));
        return HttpServerResponse.empty({ status: 204 });
      }
      if (path === "/v1/mail/download")
        return HttpServerResponse.jsonUnsafe(
          await runtime.download(
            ownerSubject,
            companyId,
            required(body.messageId, "message"),
            required(body.blobKey, "attachment"),
          ),
          { headers: { "cache-control": "no-store" } },
        );
      return HttpServerResponse.empty({ status: 404 });
    } catch (error) {
      return HttpServerResponse.jsonUnsafe(
        {
          error:
            error instanceof MailHttpError
              ? error.message
              : "The email request could not be completed. Try again.",
        },
        {
          status: error instanceof MailHttpError ? error.status : 500,
          headers: { "cache-control": "no-store" },
        },
      );
    }
  });
});
export const mailRoutes = Layer.mergeAll(
  HttpRouter.add("POST", "/v1/mail/oauth/start", mailHandler),
  HttpRouter.add("GET", "/v1/mail/oauth/callback", mailHandler),
  HttpRouter.add("POST", "/v1/mail/notify", mailHandler),
  HttpRouter.add("POST", "/v1/mail/disconnect", mailHandler),
  HttpRouter.add("POST", "/v1/mail/wake", mailHandler),
  HttpRouter.add("POST", "/v1/mail/download", mailHandler),
  HttpRouter.add("GET", "/v1/mail/config", mailHandler),
);
