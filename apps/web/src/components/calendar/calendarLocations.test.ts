import { describe, expect, it, vi } from "vite-plus/test";

import { retrieveCalendarLocation, searchCalendarLocations } from "./calendarLocations";

describe("calendar location search", () => {
  it("uses Mapbox autocomplete sessions and discards malformed suggestions", async () => {
    const requested: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      requested.push(String(input));
      return Response.json({
        suggestions: [
          { mapbox_id: "place.1", name: "Martin Place", place_formatted: "Sydney NSW" },
          { name: "Missing id" },
        ],
      });
    });
    const result = await searchCalendarLocations({
      query: "Martin Place",
      token: "pk.test",
      sessionToken: "session-1",
      language: "en",
      signal: new AbortController().signal,
      fetcher,
    });
    expect(result).toEqual([{ id: "place.1", label: "Martin Place, Sydney NSW" }]);
    expect(requested[0]).toContain("session_token=session-1");
  });

  it("retrieves a selected suggestion in the same session", async () => {
    const requested: string[] = [];
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      requested.push(String(input));
      return Response.json({
        features: [{ properties: { full_address: "1 Martin Place, Sydney NSW" } }],
      });
    });
    await expect(
      retrieveCalendarLocation({
        suggestion: { id: "place.1", label: "Martin Place, Sydney NSW" },
        token: "pk.test",
        sessionToken: "session-1",
        language: "en",
        fetcher,
      }),
    ).resolves.toBe("1 Martin Place, Sydney NSW");
    expect(requested[0]).toContain("retrieve/place.1");
  });
});
