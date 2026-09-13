import { EnvironmentId, ProviderInstanceId } from "@spiritdevs/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { ...actual, ...reactHookHarness };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("../../cloud/activeCompany", () => ({
  activeCompanyIdAtom: "active",
  companyListAtom: "companies",
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: string) =>
    atom === "active"
      ? "a"
      : [
          { id: "a", name: "Workspace A" },
          { id: "b", name: "Workspace B" },
        ],
}));
vi.mock("../../state/entities", () => ({ useThreadShells: () => [] }));
vi.mock("../orchestrator/OrchestratorContext", () => ({
  useOrchestrators: () => ({
    accountID: "owner",
    chats: [
      { id: "personal", title: "Personal", companyIds: [], ownerSubject: "owner" },
      { id: "a-only", title: "A only", companyIds: ["a"], ownerSubject: "owner" },
      { id: "b-only", title: "B only", companyIds: ["b"], ownerSubject: "owner" },
      { id: "shared", title: "Shared", companyIds: ["a", "b"], ownerSubject: "owner" },
      { id: "other-owner", title: "Other owner", companyIds: ["a"], ownerSubject: "someone-else" },
    ],
  }),
}));
vi.mock("./AllowanceBudgets", () => ({ AllowanceBudgets: () => null }));

import { ProviderAllowanceContent } from "./ProviderAllowanceDialog";

function render() {
  hooks.beginRender();
  return ProviderAllowanceContent({
    target: {
      environmentId: EnvironmentId.make("studio"),
      instanceId: ProviderInstanceId.make("work"),
      provider: "codex",
      displayName: "Work",
    },
  });
}
function select(tree: unknown, label: string) {
  const field = visitElements(
    tree,
    (element) =>
      element.type === "label" &&
      Array.isArray(element.props.children) &&
      element.props.children[0] === label,
  );
  const select = visitElements(field, (element) => element.type === "select");
  expect(select).not.toBeNull();
  return select!;
}
function conversationIds(tree: unknown) {
  const ids: string[] = [];
  visitElements(select(tree, "Thread or conversation"), (element) => {
    if (element.type === "option" && element.props.value)
      ids.push(JSON.parse(String(element.props.value))[1]);
    return false;
  });
  return ids;
}

describe("allowance conversation workspace selection", () => {
  beforeEach(() => hooks.reset());
  it("offers owned personal conversations and conversations in the selected workspace", () => {
    expect(conversationIds(render())).toEqual(["personal", "a-only", "shared"]);
  });
  it("updates eligible conversations and clears the selection when switching workspaces", () => {
    (
      select(render(), "Thread or conversation").props.onChange as (event: {
        target: { value: string };
      }) => void
    )({ target: { value: JSON.stringify(["chat", "a-only"]) } });
    expect(select(render(), "Thread or conversation").props.value).toBe(
      JSON.stringify(["chat", "a-only"]),
    );
    (
      select(render(), "Workspace").props.onChange as (event: { target: { value: string } }) => void
    )({ target: { value: "b" } });
    const tree = render();
    expect(conversationIds(tree)).toEqual(["personal", "b-only", "shared"]);
    expect(select(tree, "Thread or conversation").props.value).toBe("");
  });
});
