import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "../test/reactHookHarness";
import { visitElements } from "../test/reactElementTree";
import {
  TemporaryThreadDiscardDialog,
  requestTemporaryThreadDiscard,
} from "./TemporaryThreadDiscardDialog";
import { Button } from "./ui/button";

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, getSnapshot: () => unknown) => getSnapshot(),
}));
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});

function render() {
  hooks.beginRender();
  return TemporaryThreadDiscardDialog();
}
function choose(label: string) {
  const item = visitElements(
    render(),
    (element) => element.type === Button && element.props.children === label,
  )!;
  (item.props.onClick as () => void)();
}
beforeEach(() => hooks.reset());

it("requires a separate named decision for every dirty thread in a bulk settlement", async () => {
  const first = requestTemporaryThreadDiscard("First temporary conversation");
  const second = requestTemporaryThreadDiscard("Second temporary conversation");
  const firstDialog = render();
  expect(JSON.stringify(firstDialog)).toContain("First temporary conversation");
  expect(JSON.stringify(firstDialog)).not.toContain("Second temporary conversation");
  for (const label of ["Review changes", "Cancel", "Discard and delete"]) {
    expect(
      visitElements(
        firstDialog,
        (element) => element.type === Button && element.props.children === label,
      ),
    ).not.toBeNull();
  }
  choose("Cancel");
  expect(await first).toBe("cancel");
  expect(JSON.stringify(render())).toContain("Second temporary conversation");
  choose("Discard and delete");
  expect(await second).toBe("discard");
  expect(render().props.open).toBe(false);
});

it("review leaves the named thread undeleted", async () => {
  const choice = requestTemporaryThreadDiscard("Review this work");
  choose("Review changes");
  expect(await choice).toBe("review");
  expect(render().props.open).toBe(false);
});
