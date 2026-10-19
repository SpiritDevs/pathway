import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { Atom } from "effect/unstable/reactivity";
import * as Schema from "effect/Schema";
import type { ConvexClient } from "convex/browser";
import { FocusNotification } from "@spiritdevs/contracts/focus";
import type { AlertPolicyRow } from "@spiritdevs/contracts/threadAlerts";
import { appAtomRegistry, resetAppAtomRegistryForTests } from "../rpc/atomRegistry";
import {
  subscribeThreadAlertPolicies,
  threadAlertAccountAtom,
  threadAlertPoliciesAtom,
  threadAlertPoliciesReadyAtom,
  threadAlertPoliciesErrorAtom,
  threadAlertPolicyScopesAtom,
} from "./state";

vi.mock("../state/projects", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return { environmentProjects: { projectsAtom: Atom.make([]) } };
});
vi.mock("../state/threads", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return { environmentThreadShells: { threadRefsAtom: Atom.make([]) } };
});

const cleanup: Array<() => void> = [];
beforeEach(() => resetAppAtomRegistryForTests());
afterEach(() => {
  for (const stop of cleanup.splice(0)) stop();
});
function clientHarness() {
  const queries: Array<{
    scopes: { projectKeys: string[]; threadKeys: string[] };
    update: (rows: readonly AlertPolicyRow[]) => void;
    error: (error: Error) => void;
  }> = [];
  const client = {
    onUpdate: (
      _reference: unknown,
      scopes: { projectKeys: string[]; threadKeys: string[] },
      update: (rows: readonly AlertPolicyRow[]) => void,
      error: (error: Error) => void,
    ) => {
      queries.push({ scopes, update, error });
      return () => {};
    },
    connectionState: () => ({ isWebSocketConnected: true }),
    subscribeToConnectionState: () => () => {},
    mutation: async () => null,
  } as unknown as ConvexClient;
  return { client, queries };
}
const row: AlertPolicyRow = {
  scopeKind: "global",
  scopeKey: "global",
  choices: { completion: true },
};
const notification = Schema.decodeUnknownSync(FocusNotification)({
  id: "event",
  eventId: "event",
  environmentId: "env",
  threadId: "thread",
  projectKey: "env:old-project",
  alertProjectKey: "old-repository",
  eventKind: "finished-unsettled",
  createdAt: 1,
});

describe("alert policy subscription", () => {
  it("includes event-origin scopes even after its project and thread disappear from the sidebar", () => {
    const { client, queries } = clientHarness();
    cleanup.push(subscribeThreadAlertPolicies(client, "user", Atom.make([notification])));
    expect(queries[0]?.scopes).toEqual({
      projectKeys: ["old-repository"],
      threadKeys: ["environment:env:thread:thread"],
    });
    queries[0]?.update([row]);
    expect(appAtomRegistry.get(threadAlertPolicyScopesAtom)).toEqual(queries[0]?.scopes);
    expect(appAtomRegistry.get(threadAlertPoliciesReadyAtom)).toBe(true);
  });
  it("ignores replaced query results while the new scope list loads", () => {
    const { client, queries } = clientHarness();
    const notifications = Atom.make<readonly FocusNotification[]>([]);
    cleanup.push(subscribeThreadAlertPolicies(client, "user", notifications));
    queries[0]?.update([row]);
    appAtomRegistry.set(notifications, [notification]);
    expect(queries).toHaveLength(2);
    expect(appAtomRegistry.get(threadAlertPoliciesReadyAtom)).toBe(false);
    queries[0]?.update([]);
    expect(appAtomRegistry.get(threadAlertPoliciesReadyAtom)).toBe(false);
    expect(appAtomRegistry.get(threadAlertPoliciesAtom)).toEqual([row]);
    queries[1]?.update([row]);
    expect(appAtomRegistry.get(threadAlertPoliciesReadyAtom)).toBe(true);
  });
  it("reports load failures while preserving displayed policy and clears them after recovery", () => {
    const { client, queries } = clientHarness();
    const stop = subscribeThreadAlertPolicies(client, "user", Atom.make([]));
    cleanup.push(stop);
    queries[0]?.update([row]);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    queries[0]?.error(new Error("Could not find public function for threadAlertPolicies:list"));
    warning.mockRestore();
    expect(appAtomRegistry.get(threadAlertPoliciesReadyAtom)).toBe(false);
    expect(appAtomRegistry.get(threadAlertPoliciesAtom)).toEqual([row]);
    expect(appAtomRegistry.get(threadAlertPoliciesErrorAtom)).toContain(
      "Could not load thread alert settings",
    );
    queries[0]?.update([row]);
    expect(appAtomRegistry.get(threadAlertPoliciesErrorAtom)).toBeNull();
    expect(appAtomRegistry.get(threadAlertPoliciesReadyAtom)).toBe(true);
  });
  it("clears a failed subscription's error on cleanup and account replacement", () => {
    const first = clientHarness();
    const stop = subscribeThreadAlertPolicies(first.client, "old", Atom.make([]));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    first.queries[0]?.error(new Error("Unavailable"));
    expect(appAtomRegistry.get(threadAlertPoliciesErrorAtom)).not.toBeNull();
    stop();
    expect(appAtomRegistry.get(threadAlertPoliciesErrorAtom)).toBeNull();
    const second = clientHarness();
    cleanup.push(subscribeThreadAlertPolicies(second.client, "new", Atom.make([])));
    first.queries[0]?.error(new Error("Late old account failure"));
    warning.mockRestore();
    expect(appAtomRegistry.get(threadAlertPoliciesErrorAtom)).toBeNull();
  });
  it("clears errors for a new scope request and ignores the prior query's late error", () => {
    const { client, queries } = clientHarness();
    const notifications = Atom.make<readonly FocusNotification[]>([]);
    cleanup.push(subscribeThreadAlertPolicies(client, "user", notifications));
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    queries[0]?.error(new Error("Unavailable"));
    appAtomRegistry.set(notifications, [notification]);
    expect(appAtomRegistry.get(threadAlertPoliciesErrorAtom)).toBeNull();
    queries[0]?.error(new Error("Stale error"));
    warning.mockRestore();
    expect(appAtomRegistry.get(threadAlertPoliciesErrorAtom)).toBeNull();
    expect(appAtomRegistry.get(threadAlertPoliciesReadyAtom)).toBe(false);
  });
  it("ignores late callbacks after account cleanup", () => {
    const first = clientHarness();
    const stop = subscribeThreadAlertPolicies(first.client, "old", Atom.make([]));
    stop();
    const second = clientHarness();
    cleanup.push(subscribeThreadAlertPolicies(second.client, "new", Atom.make([])));
    first.queries[0]?.update([row]);
    expect(appAtomRegistry.get(threadAlertAccountAtom)).toBe("new");
    expect(appAtomRegistry.get(threadAlertPoliciesAtom)).toBeNull();
    expect(appAtomRegistry.get(threadAlertPoliciesReadyAtom)).toBe(false);
    second.queries[0]?.update([]);
    expect(appAtomRegistry.get(threadAlertPoliciesReadyAtom)).toBe(true);
    first.queries[0]?.error(new Error("Old query failed"));
    expect(appAtomRegistry.get(threadAlertPoliciesReadyAtom)).toBe(true);
    expect(appAtomRegistry.get(threadAlertPoliciesErrorAtom)).toBeNull();
  });
});
