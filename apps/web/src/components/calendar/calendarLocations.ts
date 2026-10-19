import { randomUUID } from "~/lib/utils";

export interface CalendarLocationSuggestion {
  readonly id: string;
  readonly label: string;
}

interface MapboxSuggestion {
  readonly mapbox_id?: unknown;
  readonly name?: unknown;
  readonly place_formatted?: unknown;
  readonly full_address?: unknown;
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function resolveMapboxSearchToken(): string | null {
  const token = import.meta.env.VITE_MAPBOX_SEARCH_TOKEN?.trim();
  return token ? token : null;
}

export function newLocationSearchSession(): string {
  return randomUUID();
}

function suggestionLabel(suggestion: MapboxSuggestion): string | null {
  if (typeof suggestion.full_address === "string" && suggestion.full_address.trim()) {
    return suggestion.full_address.trim();
  }
  if (typeof suggestion.name !== "string" || !suggestion.name.trim()) return null;
  return typeof suggestion.place_formatted === "string" && suggestion.place_formatted.trim()
    ? `${suggestion.name.trim()}, ${suggestion.place_formatted.trim()}`
    : suggestion.name.trim();
}

export async function searchCalendarLocations(input: {
  readonly query: string;
  readonly token: string;
  readonly sessionToken: string;
  readonly language: string;
  readonly signal: AbortSignal;
  readonly fetcher?: FetchLike;
}): Promise<ReadonlyArray<CalendarLocationSuggestion>> {
  const query = new URLSearchParams({
    q: input.query.slice(0, 256),
    access_token: input.token,
    session_token: input.sessionToken,
    language: input.language,
    limit: "5",
  });
  const response = await (input.fetcher ?? fetch)(
    `https://api.mapbox.com/search/searchbox/v1/suggest?${query}`,
    { signal: input.signal },
  );
  if (!response.ok) return [];
  const payload = (await response.json()) as { suggestions?: unknown };
  if (!Array.isArray(payload.suggestions)) return [];
  return payload.suggestions.flatMap((value) => {
    if (typeof value !== "object" || value === null) return [];
    const suggestion = value as MapboxSuggestion;
    const label = suggestionLabel(suggestion);
    return typeof suggestion.mapbox_id === "string" && label !== null
      ? [{ id: suggestion.mapbox_id, label }]
      : [];
  });
}

export async function retrieveCalendarLocation(input: {
  readonly suggestion: CalendarLocationSuggestion;
  readonly token: string;
  readonly sessionToken: string;
  readonly language: string;
  readonly fetcher?: FetchLike;
}): Promise<string> {
  const query = new URLSearchParams({
    access_token: input.token,
    session_token: input.sessionToken,
    language: input.language,
  });
  const response = await (input.fetcher ?? fetch)(
    `https://api.mapbox.com/search/searchbox/v1/retrieve/${encodeURIComponent(input.suggestion.id)}?${query}`,
  );
  if (!response.ok) return input.suggestion.label;
  const payload = (await response.json()) as { features?: unknown };
  if (!Array.isArray(payload.features)) return input.suggestion.label;
  const feature = payload.features[0];
  if (typeof feature !== "object" || feature === null) return input.suggestion.label;
  const properties = (feature as { properties?: unknown }).properties;
  return typeof properties === "object" && properties !== null
    ? (suggestionLabel(properties as MapboxSuggestion) ?? input.suggestion.label)
    : input.suggestion.label;
}
