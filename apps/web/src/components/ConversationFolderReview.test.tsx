import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../test/reactHookHarness";
import { visitElements } from "../test/reactElementTree";
import { ConversationFolderReview } from "./ConversationFolderReview";
import { Button } from "./ui/button";

const state = vi.hoisted(() => ({ open: vi.fn(), ensure: vi.fn(), nextId: 0 }));
vi.mock("../state/terminal", () => ({ terminalEnvironment: { open: "open" } }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.open }));
vi.mock("../terminalUiStateStore", () => ({
  useTerminalUiStateStore: { getState: () => ({ ensureTerminal: state.ensure }) },
}));
vi.mock("../lib/utils", () => ({
  randomUUID: () => String(++state.nextId),
  cn: (...values: string[]) => values.join(" "),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: hooks.useState,
}));
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
const threadRef = {
  environmentId: EnvironmentId.make("remote-environment"),
  threadId: ThreadId.make("attached-conversation"),
};
const conversationPath = "/remote/userdata/conversations/original";
function render() {
  hooks.beginRender();
  return ConversationFolderReview({ threadRef, conversationPath });
}
async function openTerminal() {
  const button = visitElements(render(), (element) => element.type === Button)!;
  (button.props.onClick as () => void)();
  await state.open.mock.results.at(-1)?.value;
}
beforeEach(() => {
  hooks.reset();
  state.open.mockReset().mockResolvedValue({ _tag: "Success" });
  state.ensure.mockClear();
  state.nextId = 0;
});

it("shows the original folder and opens its terminal on the owning environment without a project worktree override", async () => {
  expect(JSON.stringify(render())).toContain(conversationPath);
  await openTerminal();
  expect(state.open).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: {
      threadId: threadRef.threadId,
      cwd: conversationPath,
      terminalId: "conversation-review-1",
    },
  });
  expect(state.ensure).toHaveBeenCalledWith(threadRef, "conversation-review-1", {
    active: true,
    open: true,
  });
});

it("creates a fresh terminal so an earlier shell's directory changes do not change the review destination", async () => {
  await openTerminal();
  await openTerminal();
  expect(state.open.mock.calls.map(([target]) => target.input.terminalId)).toEqual([
    "conversation-review-1",
    "conversation-review-2",
  ]);
  expect(state.open.mock.calls.every(([target]) => target.input.cwd === conversationPath)).toBe(
    true,
  );
});
