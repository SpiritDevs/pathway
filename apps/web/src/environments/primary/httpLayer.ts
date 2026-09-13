import { remoteHttpClientLayer } from "@spiritdevs/client-runtime/rpc";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";

import { readDesktopPrimaryBearerToken } from "./desktopAuth";
import { resolvePrimaryEnvironmentHttpUrl } from "./target";

function isSameOriginBrowserPrimary(): boolean {
  if (
    typeof window === "undefined" ||
    window.desktopBridge !== undefined ||
    !window.location.origin.startsWith("http")
  ) {
    return false;
  }

  return new URL(resolvePrimaryEnvironmentHttpUrl("/")).origin === window.location.origin;
}

function withPrimaryBearerToken(client: HttpClient.HttpClient): HttpClient.HttpClient {
  return client.pipe(
    HttpClient.mapRequestEffect((request) =>
      Effect.promise(readDesktopPrimaryBearerToken).pipe(
        Effect.map((bearerToken) =>
          bearerToken ? HttpClientRequest.bearerToken(request, bearerToken) : request,
        ),
      ),
    ),
  );
}

export function makePrimaryEnvironmentHttpLayer() {
  return Layer.unwrap(
    Effect.sync(() => {
      const baseLayer = remoteHttpClientLayer(globalThis.fetch);
      const cookieAuth = isSameOriginBrowserPrimary();
      const primaryOrigin = cookieAuth ? window.location.origin : null;
      return Layer.effect(
        HttpClient.HttpClient,
        Effect.map(HttpClient.HttpClient, (client) =>
          (cookieAuth ? client : withPrimaryBearerToken(client)).pipe(
            HttpClient.transform((response, request) =>
              response.pipe(
                Effect.provideService(FetchHttpClient.RequestInit, {
                  credentials:
                    cookieAuth && new URL(request.url).origin === primaryOrigin
                      ? "include"
                      : "omit",
                }),
              ),
            ),
          ),
        ),
      ).pipe(Layer.provide(baseLayer));
    }),
  );
}

export const primaryEnvironmentHttpLayer = makePrimaryEnvironmentHttpLayer();
