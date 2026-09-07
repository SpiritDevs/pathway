import "fake-indexeddb/auto";
import { describe, expect, it } from "vite-plus/test";
import {
  claimAlertDelivery,
  releaseAlertLease,
  updateAlertPresence,
  saveAlertSound,
  readAlertSound,
  deleteAlertSound,
} from "./storage.ts";
import { alertDeliveryThreadKey, type AlertDeliveryEvent } from "./index.ts";

const NOW = 1_800_000_000_000;
const event: AlertDeliveryEvent = {
  eventId: "a",
  environmentId: "env",
  threadId: "thread",
  kind: "finished-unsettled",
  createdAt: NOW,
  threadTitle: "Thread",
  projectName: "Project",
  alertEligibleAtCreation: true,
  isRead: false,
};
const input = (events: readonly AlertDeliveryEvent[], now = NOW) => ({
  events,
  now,
  quiet: false,
  catchUp: false,
  eligible: () => true,
});

describe("transactional installation storage", () => {
  it("grants only one tab a lease and persists its claims before another tab takes over", async () => {
    await claimAlertDelivery("concurrent", "tab-a", input([]));
    const [first, second] = await Promise.all([
      claimAlertDelivery("concurrent", "tab-a", input([event])),
      claimAlertDelivery("concurrent", "tab-b", input([event])),
    ]);
    expect(first?.actions).toHaveLength(1);
    expect(second).toBeNull();
    await releaseAlertLease("concurrent", "tab-a");
    const takeover = await claimAlertDelivery("concurrent", "tab-b", input([event]));
    expect(takeover?.actions).toEqual([]);
    expect(takeover?.state.installationId).toBe("tab-a");
  });
  it("expires abandoned leases and fences the old owner after takeover", async () => {
    await claimAlertDelivery("expired", "tab-a", input([]));
    const takeover = await claimAlertDelivery("expired", "tab-b", input([event], NOW + 15_001));
    expect(takeover?.actions).toHaveLength(1);
    expect(await claimAlertDelivery("expired", "tab-a", input([event], NOW + 15_002))).toBeNull();
  });
  it("serializes simultaneous first-start baselines across tabs", async () => {
    const results = await Promise.all([
      claimAlertDelivery("baseline", "tab-a", input([event])),
      claimAlertDelivery("baseline", "tab-b", input([event])),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.flatMap((result) => result?.actions ?? [])).toEqual([]);
  });
  it("suppresses a thread focused in another tab but not another account", async () => {
    await claimAlertDelivery("foreground", "leader", input([]));
    await updateAlertPresence("foreground", "focused-tab", alertDeliveryThreadKey(event), NOW);
    const result = await claimAlertDelivery("foreground", "leader", input([event]));
    expect(result?.actions).toEqual([]);
    await claimAlertDelivery("other-account", "leader", input([]));
    expect(
      (await claimAlertDelivery("other-account", "leader", input([event])))?.actions,
    ).toHaveLength(1);
  });
  it("expires a closed tab's focused presence", async () => {
    await claimAlertDelivery("stale-presence", "leader", input([]));
    await updateAlertPresence("stale-presence", "closed-tab", alertDeliveryThreadKey(event), NOW);
    const result = await claimAlertDelivery(
      "stale-presence",
      "leader",
      input([event], NOW + 25_001),
    );
    expect(result?.actions).toHaveLength(1);
  });
  it("isolates audio assets by account and removes only the chosen asset", async () => {
    const bytes = new Blob(["audio"], { type: "audio/mpeg" });
    await saveAlertSound("sound-account", "custom", bytes);
    expect(await readAlertSound("different-account", "custom")).toBeUndefined();
    expect(await (await readAlertSound("sound-account", "custom"))?.text()).toBe("audio");
    await deleteAlertSound("sound-account", "custom");
    expect(await readAlertSound("sound-account", "custom")).toBeUndefined();
  });
});
