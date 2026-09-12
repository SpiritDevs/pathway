// @effect-diagnostics globalDate:off -- Convex mutations use the transaction clock.
// @effect-diagnostics globalFetch:off -- Convex actions call the email provider directly.
import { v } from "convex/values";

import { internal } from "./_generated/api.js";
import { internalAction, internalMutation, internalQuery, mutation } from "./_generated/server.js";

/** Mirrors LoginErrorReport in packages/contracts/src/loginErrorReports.ts. */
export const reportFields = {
  reportId: v.string(),
  installationId: v.string(),
  occurredAt: v.string(),
  appVersion: v.string(),
  osVersion: v.string(),
  errorDomain: v.string(),
  errorCode: v.number(),
  kind: v.union(v.literal("cancelled"), v.literal("connection"), v.literal("unknown")),
};

const HOUR = 60 * 60 * 1000;
const MAX_ATTEMPTS = 6;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Public because a failed login has no account token. Only fixed-format diagnostics are accepted. */
export const submit = mutation({
  args: reportFields,
  returns: v.null(),
  handler: async (ctx, report) => {
    if (
      !UUID.test(report.reportId) ||
      !UUID.test(report.installationId) ||
      !Number.isSafeInteger(report.errorCode) ||
      !Number.isFinite(Date.parse(report.occurredAt)) ||
      report.occurredAt.length > 40 ||
      [report.appVersion, report.osVersion, report.errorDomain].some(
        (value) => value.length === 0 || value.length > 160 || /[\r\n]/.test(value),
      )
    )
      throw new Error("Invalid login report");
    const existing = await ctx.db
      .query("loginErrorReports")
      .withIndex("by_reportId", (q) => q.eq("reportId", report.reportId))
      .unique();
    if (existing) return null;
    const now = Date.now();
    const recent = await ctx.db
      .query("loginErrorReports")
      .withIndex("by_createdAt", (q) => q.gte("createdAt", now - HOUR))
      .take(100);
    if (
      recent.length >= 100 ||
      recent.filter((row) => row.installationId === report.installationId).length >= 5
    ) {
      throw new Error("Support report limit reached; retry later");
    }
    const id = await ctx.db.insert("loginErrorReports", {
      ...report,
      createdAt: now,
      attempts: 0,
      sentAt: null,
    });
    await ctx.scheduler.runAfter(0, internal.loginErrorReports.deliver, { id });
    return null;
  },
});

export const read = internalQuery({
  args: { id: v.id("loginErrorReports") },
  handler: (ctx, { id }) => ctx.db.get(id),
});

export const recordDelivery = internalMutation({
  args: { id: v.id("loginErrorReports"), sent: v.boolean() },
  handler: async (ctx, { id, sent }) => {
    const report = await ctx.db.get(id);
    if (!report || report.sentAt !== null) return;
    const attempts = report.attempts + 1;
    await ctx.db.patch(id, { attempts, sentAt: sent ? Date.now() : null });
    if (!sent && attempts < MAX_ATTEMPTS) {
      await ctx.scheduler.runAfter(
        Math.min(60_000 * 2 ** (attempts - 1), HOUR),
        internal.loginErrorReports.deliver,
        { id },
      );
    }
  },
});

export const deliver = internalAction({
  args: { id: v.id("loginErrorReports") },
  handler: async (ctx, { id }) => {
    const report = await ctx.runQuery(internal.loginErrorReports.read, { id });
    if (!report || report.sentAt !== null || report.attempts >= MAX_ATTEMPTS) return;
    const apiKey = process.env.RESEND_API_KEY?.trim();
    if (!apiKey) {
      // @effect-diagnostics-next-line globalConsole:off -- Convex captures console output in its function logs.
      console.warn("loginErrorReports: email skipped because RESEND_API_KEY is not configured", {
        reportId: report.reportId,
        occurredAt: report.occurredAt,
        kind: report.kind,
        appVersion: report.appVersion,
        osVersion: report.osVersion,
        errorDomain: report.errorDomain,
        errorCode: report.errorCode,
      });
      return;
    }
    let sent = false;
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Idempotency-Key": `pathway-login/${report.reportId}`,
        },
        body: JSON.stringify({
          from: "Pathway <no-reply@pathwayos.app>",
          to: ["support@pathwayos.app"],
          subject: "Pathway login error report",
          text: [
            "An Apple client reported an unsuccessful login.",
            `Report ID: ${report.reportId}`,
            `Time: ${report.occurredAt}`,
            `Kind: ${report.kind}`,
            `App: ${report.appVersion}`,
            `OS: ${report.osVersion}`,
            `Error: ${report.errorDomain} (${report.errorCode})`,
          ].join("\n"),
        }),
        signal: AbortSignal.timeout(10_000),
      });
      sent = response.ok;
    } catch {
      // Keep provider responses and credentials out of client errors; the durable job retries.
    }
    await ctx.runMutation(internal.loginErrorReports.recordDelivery, { id, sent });
  },
});

export const pruneSent = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db
      .query("loginErrorReports")
      .withIndex("by_sentAt", (q) => q.gt("sentAt", 0).lt("sentAt", Date.now() - 7 * 24 * HOUR))
      .take(100);
    for (const row of rows) await ctx.db.delete(row._id);
  },
});
