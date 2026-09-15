import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { OrchestratorChat } from "@spiritdevs/contracts/aiOrchestrator";
import { claimOrchestratorNotification, shouldNotifyOrchestrator } from "./notificationDelivery";
const chat: OrchestratorChat = {
  id: "chat",
  title: "Chief",
  kind: "dm",
  ownerSubject: "owner",
  orchestratorIds: ["chief"],
  leadId: "chief",
  participantSubjects: ["owner"],
  companyIds: [],
  archived: false,
  lastSequence: 8,
  readSequence: 6,
  lastMessage: "Ready",
  updatedAt: 200,
  createdAt: 0,
  notification: {
    sequence: 8,
    senderName: "Chief",
    text: "Ready",
    enabled: true,
    urgent: false,
    createdAt: 200,
  },
};
const input = { chat, seenSequence: 7, startedAt: 100, focusedChatId: null, quiet: false };
afterEach(() => vi.unstubAllGlobals());
describe("orchestrator notification delivery", () => {
  it("delivers a new unread reply and suppresses read, visible, quiet, archived, and old updates", () => {
    expect(shouldNotifyOrchestrator(input)).toBe(true);
    for (const change of [
      { seenSequence: 8 },
      { startedAt: 201 },
      { focusedChatId: "chat" },
      { quiet: true },
      { chat: { ...chat, archived: true } },
      { chat: { ...chat, readSequence: 8 } },
      { chat: { ...chat, notification: { ...chat.notification!, enabled: false } } },
    ])
      expect(shouldNotifyOrchestrator({ ...input, ...change })).toBe(false);
  });
  it("claims an update once across tabs and retains suppressed watermarks across reloads", async () => {
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
    });
    let pending = Promise.resolve<unknown>(null);
    vi.stubGlobal("navigator", {
      locks: {
        request: (_key: string, callback: () => unknown) => (pending = pending.then(callback)),
      },
    });
    expect(
      await Promise.all([
        claimOrchestratorNotification("owner", chat, () => true),
        claimOrchestratorNotification("owner", chat, () => true),
      ]),
    ).toEqual([true, false]);
    const next = { ...chat, notification: { ...chat.notification!, sequence: 9 } };
    expect(await claimOrchestratorNotification("owner", next, () => false)).toBe(false);
    expect(await claimOrchestratorNotification("owner", next, () => true)).toBe(false);
    expect(await claimOrchestratorNotification("another-user", next, () => true)).toBe(true);
    const later = { ...chat, notification: { ...chat.notification!, sequence: 10 } };
    expect(await claimOrchestratorNotification("owner", later, () => null)).toBe(false);
    expect(await claimOrchestratorNotification("owner", later, () => true)).toBe(true);
  });
  it("does not deliver without a durable cross-tab claim", async () => {
    vi.stubGlobal("navigator", {});
    expect(await claimOrchestratorNotification("owner", chat, () => true)).toBe(false);
    vi.stubGlobal("navigator", {
      locks: { request: () => Promise.reject(new Error("Storage unavailable")) },
    });
    expect(await claimOrchestratorNotification("owner", chat, () => true)).toBe(false);
  });
});

describe("human attention in group coordination", () => {
  const group = {
    ...chat,
    kind: "group" as const,
    notification: {
      ...chat.notification!,
      coordination: true,
      senderId: "chief",
      mentions: [{ kind: "user" as const, id: "owner" }],
    },
  };
  it("gates the shared sound/banner decision on structured mention and membership", () => {
    expect(shouldNotifyOrchestrator({ ...input, accountID: "owner", chat: group })).toBe(true);
    expect(
      shouldNotifyOrchestrator({
        ...input,
        accountID: "owner",
        chat: { ...group, notification: { ...group.notification, mentions: [] } },
      }),
    ).toBe(false);
    expect(
      shouldNotifyOrchestrator({
        ...input,
        accountID: "outsider",
        chat: {
          ...group,
          notification: { ...group.notification, mentions: [{ kind: "user", id: "outsider" }] },
        },
      }),
    ).toBe(false);
  });
});
