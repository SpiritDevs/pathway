import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  defaultOrchestratorConfig,
  type AiOrchestrator,
  type OrchestratorChat,
} from "@spiritdevs/contracts/aiOrchestrator";
import {
  defaultConversation,
  rememberConversation,
  rememberedConversation,
} from "./defaultConversation";
const contact = (id: string, overrides: Partial<AiOrchestrator> = {}): AiOrchestrator => ({
  ...defaultOrchestratorConfig(),
  id,
  ownerSubject: "alice",
  status: "active",
  revision: 1,
  createdAt: 0,
  updatedAt: 0,
  canManage: true,
  canDirect: true,
  ...overrides,
});
const chat = (
  id: string,
  leadId: string,
  overrides: Partial<OrchestratorChat> = {},
): OrchestratorChat => ({
  id,
  leadId,
  title: id,
  kind: "dm",
  ownerSubject: "alice",
  orchestratorIds: [leadId],
  participantSubjects: ["alice"],
  companyIds: [],
  archived: false,
  lastSequence: 0,
  readSequence: 0,
  lastMessage: "",
  updatedAt: 0,
  createdAt: 0,
  ...overrides,
});
const main = contact("main"),
  other = contact("other");
const home = chat("home", "main"),
  recent = chat("recent", "other");
afterEach(() => vi.unstubAllGlobals());
describe("default conversation entry", () => {
  it("restores accessible group contacts outside the owned directory but rejects deleted recipients", () => {
    const group = chat("group", "shared", { kind: "group", orchestratorIds: ["main", "shared"] });
    const identities = [main, { id: "shared", status: "active" as const }];
    expect(defaultConversation([home, group], [main], "alice", null, "group", identities)).toBe(
      group,
    );
    expect(
      defaultConversation([home, group], [main], "alice", null, "group", [
        main,
        { id: "shared", status: "deleted" },
      ]),
    ).toBe(home);
    expect(defaultConversation([home, group], [main], "alice", null, "group", [main])).toBe(home);
  });

  it("opens the remembered accessible conversation ahead of the main personal assistant", () => {
    expect(defaultConversation([home, recent], [main, other], "alice", null, "recent")).toBe(
      recent,
    );
    expect(defaultConversation([recent, home], [main, other], "alice", null, null)).toBe(home);
  });
  it.each(["missing", "deleted", "archived", "inaccessible"])(
    "falls back from a %s remembered assistant",
    (state) => {
      const contacts =
        state === "missing" || state === "inaccessible"
          ? [main]
          : [main, contact("other", { status: state === "deleted" ? "deleted" : "archived" })];
      expect(defaultConversation([recent, home], contacts, "alice", null, "recent")).toBe(home);
    },
  );
  it("gives an explicit archive link priority without automatically opening archives", () => {
    const archive = chat("archive", "other", { archived: true, lifecycle: "archived" });
    expect(
      defaultConversation(
        [home, archive],
        [main, other],
        "alice",
        { accountID: "alice", id: "archive" },
        "home",
      ),
    ).toBe(archive);
    expect(defaultConversation([home, archive], [main, other], "alice", null, "archive")).toBe(
      home,
    );
  });
  it("does not carry selections across accounts, or select a group as personal home", () => {
    const group = chat("group", "main", { kind: "group", participantSubjects: ["alice", "bob"] });
    expect(
      defaultConversation(
        [group, home, recent],
        [main, other],
        "alice",
        { accountID: "bob", id: "recent" },
        null,
      ),
    ).toBe(home);
    expect(defaultConversation([group], [main], "alice", null, null)).toBeNull();
    expect(defaultConversation([home], [main], "bob", null, null)).toBeNull();
  });
  it("keeps paused assistants eligible without modifying their state", () => {
    const paused = contact("main", { status: "paused" });
    expect(defaultConversation([home], [paused], "alice", null, null)).toBe(home);
    expect(paused.status).toBe("paused");
  });
  it("isolates remembered choices by account and tolerates unavailable storage", () => {
    const values = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    });
    rememberConversation("alice", "recent");
    rememberConversation("bob", "bob-home");
    expect(rememberedConversation("alice")).toBe("recent");
    expect(rememberedConversation("bob")).toBe("bob-home");
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw Error("blocked");
      },
      setItem: () => {
        throw Error("blocked");
      },
    });
    expect(() => rememberConversation("alice", "home")).not.toThrow();
    expect(rememberedConversation("alice")).toBeNull();
  });
});
