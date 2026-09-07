import { describe, expect, it, vi } from "vite-plus/test";

import { relayGateway } from "./gateway.ts";

describe("relay gateway", () => {
  it("answers browser preflights without invoking the full relay Worker", async () => {
    const fetch = vi.fn();
    const response = await relayGateway.fetch(
      new Request("https://relay.example.test/v1/client/environment-link-challenges", {
        method: "OPTIONS",
      }),
      { API: { fetch } as never },
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "authorization,b3,traceparent,content-type,dpop",
    );
    expect(response.headers.get("access-control-max-age")).toBe("86400");
  });

  it("forwards non-preflight requests over the private API binding", async () => {
    const request = new Request("https://relay.example.test/v1/environments");
    const expected = new Response("forwarded", { status: 202 });
    const fetch = vi.fn().mockResolvedValue(expected);

    const response = await relayGateway.fetch(request, { API: { fetch } as never });

    expect(response).not.toBe(expected);
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("forwarded");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
  });

  it("turns service binding failures into browser-readable errors", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("worker exceeded CPU"));

    const response = await relayGateway.fetch(
      new Request("https://relay.example.test/v1/client/environment-link-challenges", {
        method: "POST",
      }),
      { API: { fetch } as never },
    );

    expect(response.status).toBe(500);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    await expect(response.json()).resolves.toMatchObject({
      _tag: "RelayInternalError",
      code: "internal_error",
      reason: "upstream_unavailable",
      traceId: expect.stringMatching(/^[a-f0-9]{32}$/u),
    });
  });
});

it("permits the OAuth state cookie only on mail credentialed CORS responses", async () => {
  const fetch = vi.fn().mockResolvedValue(new Response("ok"));
  const response = await relayGateway.fetch(
    new Request("https://relay.example.test/v1/mail/oauth/start", {
      method: "POST",
      headers: { origin: "https://app.example.test" },
    }),
    { API: { fetch } as never },
  );
  expect(response.headers.get("access-control-allow-origin")).toBe("https://app.example.test");
  expect(response.headers.get("access-control-allow-credentials")).toBe("true");
  expect(response.headers.get("vary")).toBe("Origin");
  const normal = await relayGateway.fetch(
    new Request("https://relay.example.test/v1/environments", {
      headers: { origin: "https://app.example.test" },
    }),
    { API: { fetch: vi.fn().mockResolvedValue(new Response("ok")) } as never },
  );
  expect(normal.headers.get("access-control-allow-credentials")).toBeNull();
});
