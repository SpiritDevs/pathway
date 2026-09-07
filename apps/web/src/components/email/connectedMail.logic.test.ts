import { describe, expect, it } from "vite-plus/test";
import { isCapturedEmailSearch, readMailRelayResponse } from "./connectedMail.logic";
import { parseEmailSearch } from "./emailView.logic";

describe("connected and captured mail navigation", () => {
  it("opens connected mail by default and preserves its filters in the URL", () => {
    const search = parseEmailSearch({
      source: "mail",
      account: "gmail-a",
      bucket: "noise",
      mailMessage: "message-a",
    });
    expect(search).toMatchObject({
      source: "mail",
      account: "gmail-a",
      bucket: "noise",
      mailMessage: "message-a",
    });
    expect(isCapturedEmailSearch(search)).toBe(false);
    expect(isCapturedEmailSearch(parseEmailSearch({}))).toBe(false);
  });

  it("preserves older capture links and lets an explicit mode override stale params", () => {
    for (const oldSearch of [
      { message: "captured-a" },
      { inbox: "project-a" },
      { tab: "raw" },
      { environment: "env-a" },
      { tag: "tag-a" },
      { analytics: true },
    ]) {
      expect(isCapturedEmailSearch(parseEmailSearch(oldSearch))).toBe(true);
      expect(isCapturedEmailSearch(parseEmailSearch({ ...oldSearch, source: "mail" }))).toBe(false);
    }
    expect(isCapturedEmailSearch(parseEmailSearch({ source: "capture" }))).toBe(true);
  });

  it("drops unsupported modes and buckets without blanking the mail view", () => {
    const search = parseEmailSearch({
      source: "remote-update",
      bucket: "spam",
      account: " ",
      mailMessage: "",
    });
    expect(search.source).toBeUndefined();
    expect(search.bucket).toBeUndefined();
    expect(search.account).toBeUndefined();
    expect(search.mailMessage).toBeUndefined();
  });
});

describe("mail relay response handling", () => {
  it("accepts an empty disconnect or wake confirmation", async () => {
    await expect(readMailRelayResponse(new Response(null, { status: 204 }))).resolves.toBeNull();
  });
  it("reads successful OAuth responses and preserves actionable errors", async () => {
    await expect(
      readMailRelayResponse(
        Response.json({ authorizationUrl: "https://accounts.google.com/authorize" }),
      ),
    ).resolves.toEqual({ authorizationUrl: "https://accounts.google.com/authorize" });
    await expect(
      readMailRelayResponse(Response.json({ error: "Reconnect Gmail." }, { status: 401 })),
    ).rejects.toThrow("Reconnect Gmail.");
  });
});
