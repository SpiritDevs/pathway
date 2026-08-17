interface RelayGatewayEnvironment {
  readonly API: Fetcher;
}

const CORS_PREFLIGHT_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization,b3,traceparent,content-type,dpop",
  "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
  "access-control-expose-headers": "traceparent,www-authenticate",
  "access-control-max-age": "86400",
} as const;

const withCors = (response: Response): Response => {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(CORS_PREFLIGHT_HEADERS)) {
    if (name === "access-control-max-age") continue;
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const relayUnavailableResponse = (): Response => {
  const traceBytes = crypto.getRandomValues(new Uint8Array(16));
  const traceId = Array.from(traceBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return Response.json(
    {
      _tag: "RelayInternalError",
      code: "internal_error",
      reason: "upstream_unavailable",
      traceId,
    },
    { status: 500 },
  );
};

/**
 * Keeps browser preflights below the Workers Free 10 ms CPU budget. The full relay bundles auth,
 * Convex, tracing, queues, and tunnel management, so loading it just to answer OPTIONS is both
 * wasteful and unreliable on a cold isolate.
 */
export const relayGateway = {
  async fetch(request: Request, environment: RelayGatewayEnvironment): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_PREFLIGHT_HEADERS,
      });
    }
    try {
      return withCors(await environment.API.fetch(request));
    } catch {
      return withCors(relayUnavailableResponse());
    }
  },
} satisfies ExportedHandler<RelayGatewayEnvironment>;

export default relayGateway;
