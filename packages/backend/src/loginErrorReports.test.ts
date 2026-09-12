// @effect-diagnostics globalDate:off -- Tests control the Convex transaction clock.
import { convexTest } from "convex-test";
import * as Schema from "effect/Schema";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { LoginErrorReport } from "@spiritdevs/contracts/loginErrorReports";

import { api } from "../convex/_generated/api.js";
import schema from "../convex/schema.ts";

const modules = {
  "../convex/_generated/api.js": () => import("../convex/_generated/api.js"),
  "../convex/_generated/server.js": () => import("../convex/_generated/server.js"),
  "../convex/loginErrorReports.ts": () => import("../convex/loginErrorReports.ts"),
};
const report = {
  reportId: "11111111-1111-4111-8111-111111111111",
  installationId: "22222222-2222-4222-8222-222222222222",
  occurredAt: "2026-09-12T02:00:00Z",
  appVersion: "1.0 (42)",
  osVersion: "iOS 26.3",
  errorDomain: "com.apple.AuthenticationServices.WebAuthenticationSession",
  errorCode: 1,
  kind: "cancelled" as const,
};
const send = vi.fn<typeof fetch>();
const isLoginErrorReport = Schema.is(LoginErrorReport);
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("RESEND_API_KEY", "test-key");
  vi.stubGlobal("fetch", send);
  send
    .mockReset()
    .mockImplementation(async () => new Response('{"id":"email-id"}', { status: 200 }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

it("accepts a login failure without a session and sends only to support", async () => {
  expect(isLoginErrorReport(report)).toBe(true);
  const t = convexTest(schema, modules);
  await t.mutation(api.loginErrorReports.submit, report);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(send).toHaveBeenCalledTimes(1);
  const [url, request] = send.mock.calls[0]!;
  expect(url).toBe("https://api.resend.com/emails");
  const body = JSON.parse(String(request?.body));
  expect(body.to).toEqual(["support@pathwayos.app"]);
  expect(body.from).toBe("Pathway <no-reply@pathwayos.app>");
  expect(body.text).toContain(`${report.errorDomain} (1)`);
  expect(body.text).not.toContain(report.installationId);
  const rows = await t.run((ctx) => ctx.db.query("loginErrorReports").collect());
  expect(rows[0]?.sentAt).not.toBeNull();
});

it("deduplicates the same report after a lost client response", async () => {
  const t = convexTest(schema, modules);
  await t.mutation(api.loginErrorReports.submit, report);
  await t.mutation(api.loginErrorReports.submit, report);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(send).toHaveBeenCalledTimes(1);
});

it("retries delivery with the same provider idempotency key", async () => {
  send.mockRejectedValueOnce(new Error("offline"));
  const t = convexTest(schema, modules);
  await t.mutation(api.loginErrorReports.submit, report);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(send).toHaveBeenCalledTimes(2);
  expect(
    send.mock.calls.map(([, request]) => new Headers(request?.headers).get("Idempotency-Key")),
  ).toEqual([`pathway-login/${report.reportId}`, `pathway-login/${report.reportId}`]);
});

it("bounds retries and retains failed delivery for support operations", async () => {
  send.mockImplementation(async () => new Response("unavailable", { status: 503 }));
  const t = convexTest(schema, modules);
  await t.mutation(api.loginErrorReports.submit, report);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(send).toHaveBeenCalledTimes(6);
  const rows = await t.run((ctx) => ctx.db.query("loginErrorReports").collect());
  expect(rows[0]?.sentAt).toBeNull();
  expect(rows[0]?.attempts).toBe(6);
});

it("rejects malformed reports", async () => {
  const t = convexTest(schema, modules);
  await expect(
    t.mutation(api.loginErrorReports.submit, { ...report, errorDomain: "a\nb" }),
  ).rejects.toThrow("Invalid login report");
  expect(send).not.toHaveBeenCalled();
});

it.each([undefined, "", "   "])(
  "accepts and logs reports without a Resend key (%s)",
  async (key) => {
    vi.stubEnv("RESEND_API_KEY", key);
    const log = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = convexTest(schema, modules);
    await expect(t.mutation(api.loginErrorReports.submit, report)).resolves.toBeNull();
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(send).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledExactlyOnceWith(
      "loginErrorReports: email skipped because RESEND_API_KEY is not configured",
      expect.objectContaining({
        reportId: report.reportId,
        errorDomain: report.errorDomain,
        errorCode: 1,
      }),
    );
    const rows = await t.run((ctx) => ctx.db.query("loginErrorReports").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sentAt).toBeNull();
    expect(rows[0]?.attempts).toBe(0);
    await t.mutation(api.loginErrorReports.submit, report);
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect(log).toHaveBeenCalledTimes(1);
  },
);

it("skips a queued email if the key is removed before delivery", async () => {
  const log = vi.spyOn(console, "warn").mockImplementation(() => {});
  const t = convexTest(schema, modules);
  await t.mutation(api.loginErrorReports.submit, report);
  vi.stubEnv("RESEND_API_KEY", undefined);
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(send).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledTimes(1);
});

it("limits repeated reports from one installation", async () => {
  const t = convexTest(schema, modules);
  for (let i = 0; i < 5; i++) {
    await t.mutation(api.loginErrorReports.submit, {
      ...report,
      reportId: `11111111-1111-4111-8111-11111111111${i}`,
    });
  }
  await expect(
    t.mutation(api.loginErrorReports.submit, {
      ...report,
      reportId: "11111111-1111-4111-8111-111111111119",
    }),
  ).rejects.toThrow("limit reached");
  await t.finishAllScheduledFunctions(vi.runAllTimers);
  expect(send).toHaveBeenCalledTimes(5);
});
