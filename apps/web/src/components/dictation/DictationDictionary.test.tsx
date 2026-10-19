import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { DictationCommand, DictationDictionaryList } from "@spiritdevs/contracts/dictation";
import { visitElements } from "../../test/reactElementTree";
import { reactHookHarness as hooks } from "../../test/reactHookHarness";

const mock = vi.hoisted(() => ({
  effects: [] as (() => void | (() => void))[],
  mutation: vi.fn<(reference: unknown, args: unknown) => Promise<number>>(),
  update: (_value: { revision: number; lists: readonly DictationDictionaryList[] }) => {},
  subscribed: () => {},
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
    useRef: reactHookHarness.useRef,
    useEffect: (effect: () => void | (() => void)) => mock.effects.push(effect),
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@clerk/react", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: true, userId: "test-user", getToken: vi.fn() }),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("../../cloud/publicConfig", async (original) => ({
  ...(await original<typeof import("../../cloud/publicConfig")>()),
  resolveCloudSyncConvexUrl: () => "https://test.convex.cloud",
}));
vi.mock("convex/browser", () => ({
  ConvexClient: class {
    setAuth() {}
    connectionState() {
      return { isWebSocketConnected: true };
    }
    subscribeToConnectionState() {
      return () => {};
    }
    onUpdate(_reference: unknown, _args: unknown, update: typeof mock.update) {
      mock.update = update;
      mock.subscribed();
      return () => {};
    }
    mutation = mock.mutation;
    close() {}
  },
}));

import { DictationDictionary } from "./DictationDictionary";
import { DictationAccountCoordinator, saveDictationDictionary } from "../../dictation/cloud";
import { makeDictationFixture } from "./fixtures";

const initial = [{ id: "list", name: "Personal", terms: [] }];
const remote = [{ id: "list", name: "Remote edit", terms: [] }];
let cleanup: (() => void)[];
let commands: DictationCommand[];

beforeEach(async () => {
  hooks.reset();
  mock.effects = [];
  mock.mutation.mockReset().mockResolvedValue(3);
  commands = [];
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    desktopBridge: {
      dictation: {
        execute: async (command: DictationCommand) => {
          commands.push(command);
        },
      },
    },
  });
  const subscribed = new Promise<void>((resolve) => {
    mock.subscribed = resolve;
  });
  DictationAccountCoordinator();
  cleanup = mock.effects
    .map((effect) => effect())
    .filter((value): value is () => void => typeof value === "function");
  await subscribed;
  mock.update({ revision: 1, lists: initial });
  hooks.reset();
});
afterEach(() => {
  for (const stop of cleanup) stop();
  vi.unstubAllGlobals();
});

function render(dictionary = initial) {
  hooks.beginRender();
  return DictationDictionary({
    state: { ...makeDictationFixture(), dictionary, dictionaryConnected: true },
    execute: vi.fn(),
    updatePreferences: vi.fn(),
  });
}
function rename(tree: unknown, name: string) {
  const node = visitElements(tree, (element) => element.props["aria-label"] === "List name");
  (node!.props.onChange as (event: { target: { value: string } }) => void)({
    target: { value: name },
  });
}
function click(tree: unknown, label: string) {
  const node = visitElements(
    tree,
    (element) => element.props.children === label && typeof element.props.onClick === "function",
  );
  (node!.props.onClick as () => void)();
}

describe("dictionary draft conflicts", () => {
  it("retains the draft's original base after a subscription update and further edits", async () => {
    rename(render(), "My draft");
    mock.update({ revision: 2, lists: remote });
    rename(render(remote), "More local edits");
    click(render(remote), "Save dictionary");
    // The coordinator rejects before dispatching a mutation, preserving the remote changes.
    await Promise.resolve();
    expect(mock.mutation).not.toHaveBeenCalled();
    const tree = render(remote);
    expect(
      visitElements(tree, (element) => element.props["aria-label"] === "List name")?.props.value,
    ).toBe("More local edits");
    expect(
      visitElements(
        tree,
        (element) =>
          typeof element.props.children === "string" &&
          element.props.children.includes("changed on another computer"),
      ),
    ).not.toBeNull();
    click(tree, "Discard changes");
    rename(render(remote), "Reapplied edit");
    click(render(remote), "Save dictionary");
    expect(mock.mutation).toHaveBeenCalledWith(expect.anything(), {
      revision: 2,
      lists: [{ id: "list", name: "Reapplied edit", terms: [] }],
    });
    await Promise.resolve();
    await Promise.resolve();
  });

  it("lets the backend reject a conflict that has not reached the subscription", async () => {
    mock.mutation.mockRejectedValueOnce(new Error("Dictionary revision changed"));
    await expect(saveDictationDictionary(remote, initial)).rejects.toThrow(
      "Dictionary revision changed",
    );
    expect(mock.mutation).toHaveBeenCalledWith(expect.anything(), { revision: 1, lists: remote });
  });

  it("does not replace a newer subscription with a delayed save response", async () => {
    let finish!: (revision: number) => void;
    mock.mutation.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const saving = saveDictationDictionary(
      [{ id: "list", name: "Local edit", terms: [] }],
      initial,
    );
    mock.update({ revision: 3, lists: remote });
    finish(2);
    await saving;
    expect(commands.at(-1)).toEqual({ type: "dictionary", lists: remote, connected: true });
    await saveDictationDictionary(initial, remote);
    expect(mock.mutation).toHaveBeenLastCalledWith(expect.anything(), {
      revision: 3,
      lists: initial,
    });
  });
});
