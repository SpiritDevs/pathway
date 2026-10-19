import { companyEntityCodec } from "@spiritdevs/client-runtime/sync";
import * as Option from "effect/Option";
import { EnvironmentId, ProviderInstanceId } from "@spiritdevs/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";
import { visitElements } from "../../test/reactElementTree";

const state = vi.hoisted(() => ({ replicas: new Map<string, { view: Map<string, unknown> }>() }));

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
    atom === "replicas"
      ? state.replicas
      : atom === "active"
        ? "a"
        : [
            { id: "a", name: "Workspace A" },
            { id: "b", name: "Workspace B" },
          ],
}));
vi.mock("../../cloud/companyRegistryReplica", () => ({ companyRegistryReplicasAtom: "replicas" }));
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

function thread(id: string, environmentId = "studio", title = id, deletedAt: string | null = null) {
  const codec = companyEntityCodec("agentThread");
  if (!codec) throw new Error("Missing agent thread codec");
  return Option.getOrThrow(
    codec.decode({
      id: `${environmentId}:${id}`,
      environmentId,
      cloudProjectId: "cloud-project",
      shell: {
        createdBy: "user",
        creationSource: "web",
        id,
        projectId: "project",
        title,
        providerInstanceId: "codex",
        modelSelection: { instanceId: "codex", model: "gpt-5" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "main",
        worktreePath: "/work/project",
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
        forkedFrom: null,
        activeProviderThreadId: null,
        latestRunId: null,
        activeRunId: null,
        status: "idle",
        pendingRuntimeRequest: null,
        latestVisibleMessage: null,
        latestUserMessageAt: null,
        hasActionableProposedPlan: false,
        pendingBackgroundTasks: [],
        itemCount: 0,
        visibleItemCount: 0,
        createdAt: "2026-09-14T00:00:00Z",
        updatedAt: "2026-09-14T00:00:00Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt,
      },
      updatedAt: 2000,
    }),
  );
}
function replica(...threads: ReturnType<typeof thread>[]) {
  return { view: new Map(threads.map((thread) => [String(thread.id), thread])) };
}
function threadIds(tree: unknown) {
  const ids: string[] = [];
  visitElements(select(tree, "Thread or conversation"), (element) => {
    if (element.type === "option" && element.props.value) {
      const scope = JSON.parse(String(element.props.value));
      if (scope[0] === "thread") ids.push(scope[2]);
    }
    return false;
  });
  return ids;
}

describe("allowance workspace selection", () => {
  beforeEach(() => {
    hooks.reset();
    state.replicas = new Map();
  });
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
  it("loads threads from the locally selected workspace without changing the active workspace", () => {
    state.replicas = new Map([
      ["a", replica(thread("a-thread"), thread("same-id", "studio", "A title"))],
      [
        "b",
        replica(
          thread("b-thread"),
          thread("same-id", "studio", "B title"),
          thread("other-environment", "laptop"),
          thread("deleted", "studio", "Deleted", "2026-09-14T00:00:00Z"),
        ),
      ],
    ]);
    expect(threadIds(render())).toEqual(["a-thread", "same-id"]);
    (
      select(render(), "Thread or conversation").props.onChange as (event: {
        target: { value: string };
      }) => void
    )({ target: { value: JSON.stringify(["thread", "studio", "same-id"]) } });
    (
      select(render(), "Workspace").props.onChange as (event: { target: { value: string } }) => void
    )({ target: { value: "b" } });
    const tree = render();
    expect(threadIds(tree)).toEqual(["b-thread", "same-id"]);
    expect(select(tree, "Thread or conversation").props.value).toBe("");
    expect(
      visitElements(
        tree,
        (element) => element.type === "option" && element.props.children === "Thread · B title",
      ),
    ).not.toBeNull();
    expect(
      visitElements(
        tree,
        (element) => element.type === "option" && element.props.children === "Thread · A title",
      ),
    ).toBeNull();
  });
  it("does not fall back to the active workspace while the chosen workspace replica is missing", () => {
    state.replicas = new Map([["a", replica(thread("a-thread"))]]);
    (
      select(render(), "Workspace").props.onChange as (event: { target: { value: string } }) => void
    )({ target: { value: "b" } });
    expect(threadIds(render())).toEqual([]);
  });
});
