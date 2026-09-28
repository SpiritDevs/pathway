// @effect-diagnostics globalDate:off -- Every HTTP request uses a fake; this exercises the pinned SRP implementation.
import { describe, expect, it, vi } from "vite-plus/test";
import { AppleCookieHttp, LiveAppleIdProtocol, type AppleHttp } from "./AppleIdProtocol.ts";
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
function fakeApple() {
  const requests: { url: string; init: RequestInit }[] = [];
  const http: AppleHttp = vi.fn(async (url, init) => {
    requests.push({ url, init });
    if (url.endsWith("/logout"))
      return new Response(null, {
        status: 302,
        headers: {
          location: "https://idmsa.apple.com/appleauth/auth/signin?widgetKey=test-widget",
        },
      });
    if (url.includes("auth/signin?"))
      return new Response("", {
        headers: { "x-apple-hc-bits": "1", "x-apple-hc-challenge": "test-challenge" },
      });
    if (url.endsWith("/signin/init"))
      return json({
        iteration: 10,
        salt: Buffer.alloc(16, 1).toString("base64"),
        protocol: "s2k",
        b: Buffer.alloc(256, 2).toString("base64"),
        c: "test-srp",
      });
    if (url.endsWith("/signin/complete"))
      return json({}, 409, { scnt: "SECRET-SCNT", "x-apple-id-session-id": "SECRET-SESSION" });
    if (url.endsWith("/auth"))
      return json({ trustedPhoneNumbers: [{ id: 1, numberWithDialCode: "••31" }] });
    if (url.endsWith("/securitycode")) return json({});
    if (url.endsWith("/verify/phone")) return json({});
    if (url.endsWith("/2sv/trust"))
      return json({}, 200, {
        "set-cookie": "myacinfo=SEALED-COOKIE; Domain=.apple.com; Path=/; Secure; HttpOnly",
      });
    if (url.endsWith("/olympus/v1/session"))
      return json({ user: { emailAddress: "owner@apple.test" } });
    if (url.endsWith("/listTeams.action"))
      return json({
        teams: [{ teamId: "DEVELOPER1", name: "Example", type: "Company/Organization" }],
      });
    throw new Error(`Unexpected request ${url}`);
  });
  return { http, requests };
}
describe("Apple ID HTTP protocol", () => {
  it("uses SRP proofs, exports cookies, discovers Developer teams and never sends the password", async () => {
    const h = fakeApple();
    const protocol = new LiveAppleIdProtocol(h.http, () => 1000);
    const signal = new AbortController().signal;
    expect(await protocol.start("owner@apple.test", "NEVER-STORE-PASSWORD", signal)).toEqual({
      kind: "trusted-device",
      destination: null,
      phoneNumbers: [{ id: 1, destination: "••31" }],
    });
    const srp = h.requests.find((r) => r.url.endsWith("/signin/complete"));
    expect(JSON.parse(String(srp?.init.body))).toMatchObject({
      accountName: "owner@apple.test",
      m1: expect.any(String),
      m2: expect.any(String),
    });
    const result = await protocol.complete("123456", signal);
    expect(result.credential.cookies).toEqual([
      {
        key: "myacinfo",
        value: "SEALED-COOKIE",
        domain: "apple.com",
        path: "/",
        secure: true,
        httpOnly: true,
        expires: null,
      },
    ]);
    expect(result.teams).toEqual([{ teamId: "DEVELOPER1", name: "Example", type: "organization" }]);
    expect(JSON.stringify(h.requests)).not.toContain("NEVER-STORE-PASSWORD");
    expect(JSON.stringify(result)).not.toContain("123456");
    protocol.dispose();
  });
  it("supports explicit SMS selection and rejects unrelated phone IDs", async () => {
    const h = fakeApple();
    const protocol = new LiveAppleIdProtocol(h.http);
    const signal = new AbortController().signal;
    await protocol.start("owner@apple.test", "password", signal);
    await expect(protocol.requestCode(999, signal)).rejects.toMatchObject({
      code: "invalid-response",
    });
    expect(await protocol.requestCode(1, signal)).toMatchObject({
      kind: "sms",
      destination: "••31",
    });
    await protocol.complete("123456", signal);
    expect(
      h.requests.find((r) => r.url.includes("/verify/phone/securitycode"))?.init.body,
    ).toContain('"phoneNumber":{"id":1}');
    protocol.dispose();
  });
  it("keeps concurrent account cookie jars isolated during the library's shared SRP exchange", async () => {
    const a = fakeApple();
    const b = fakeApple();
    const one = new LiveAppleIdProtocol(a.http);
    const two = new LiveAppleIdProtocol(b.http);
    await Promise.all([
      one.start("one@apple.test", "ONE", new AbortController().signal),
      two.start("two@apple.test", "TWO", new AbortController().signal),
    ]);
    expect(JSON.stringify(a.requests)).not.toContain("two@apple.test");
    expect(JSON.stringify(b.requests)).not.toContain("one@apple.test");
    one.dispose();
    two.dispose();
  });
  it("does not forward cookies or challenge headers to another origin and rejects non-Apple redirects", async () => {
    const calls: RequestInit[] = [];
    const client = new AppleCookieHttp(async (url, init) => {
      calls.push(init);
      return url.includes("idmsa")
        ? new Response(null, {
            status: 302,
            headers: { location: "https://developer.apple.com/test" },
          })
        : new Response("ok");
    });
    client.restore({
      cookies: [
        {
          key: "secret",
          value: "private",
          domain: "idmsa.apple.com",
          path: "/",
          secure: true,
          httpOnly: true,
          expires: null,
        },
      ],
    });
    await client.request("https://idmsa.apple.com/test", {
      headers: { scnt: "private", "X-Apple-ID-Session-Id": "private" },
    });
    expect(new Headers(calls[1]?.headers).get("scnt")).toBeNull();
    expect(new Headers(calls[1]?.headers).get("cookie")).toBeNull();
    const blocked = new AppleCookieHttp(
      async () =>
        new Response(null, { status: 302, headers: { location: "https://attacker.test" } }),
    );
    await expect(blocked.request("https://apple.com/test", {})).rejects.toMatchObject({
      code: "invalid-response",
    });
  });
});
