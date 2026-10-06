import { EnvironmentId } from "@spiritdevs/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  persistPrimaryIdentity,
  primaryIdentityStorageKey,
  readCachedPrimaryIdentity,
} from "./cachedIdentity";

function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal("window", {
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    },
  });
  return values;
}
afterEach(() => vi.unstubAllGlobals());

describe("cached primary identity", () => {
  it("restores only the signed-in account's identity for the same endpoint", () => {
    storage();
    const identity = {
      environmentId: EnvironmentId.make("environment-a"),
      label: "My environment",
    };
    persistPrimaryIdentity("account-a", "http://localhost:3773/", identity);
    expect(readCachedPrimaryIdentity("account-a", "http://localhost:3773/")).toEqual(identity);
    expect(readCachedPrimaryIdentity("account-b", "http://localhost:3773/")).toBeNull();
    expect(readCachedPrimaryIdentity("account-a", "https://remote.test/")).toBeNull();
  });
  it("ignores corrupt identities and unavailable storage", () => {
    const values = storage();
    values.set(primaryIdentityStorageKey("a", "http://localhost/"), "{bad");
    expect(readCachedPrimaryIdentity("a", "http://localhost/")).toBeNull();
    vi.stubGlobal("window", {});
    expect(() =>
      persistPrimaryIdentity("a", "http://localhost/", {
        environmentId: EnvironmentId.make("e"),
        label: "E",
      }),
    ).not.toThrow();
    expect(readCachedPrimaryIdentity("a", "http://localhost/")).toBeNull();
  });
});
