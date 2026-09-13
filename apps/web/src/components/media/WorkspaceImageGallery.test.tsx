import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import type { ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vite-plus/test";
import { reactHookHarness as hooks } from "~/test/reactHookHarness";
import { WorkspaceImageGallery } from "./WorkspaceImageGallery";
import type { ImageLightboxProps } from "./ImageLightbox";

vi.mock("../assets/useWorkspaceAssetPublishAction", () => ({
  useWorkspaceAssetPublishAction: () => [],
}));

vi.mock("./ImageLightbox", () => ({ ImageLightbox: () => null }));

const state = vi.hoisted(() => ({
  effects: [] as Array<() => () => void>,
  createUrl: vi.fn(),
  search: vi.fn(),
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return {
    ...actual,
    useState: reactHookHarness.useState,
    useEffect: (effect: () => () => void) => state.effects.push(effect),
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("~/test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("~/state/session", () => ({
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "https://remote.example" } }),
}));
vi.mock("~/state/assets", () => ({ assetEnvironment: { createUrl: "asset" } }));
vi.mock("~/state/projects", () => ({ projectEnvironment: { searchEntries: "search" } }));
vi.mock("~/state/use-atom-query-runner", () => ({
  useAtomQueryRunner: (kind: string) => (kind === "asset" ? state.createUrl : state.search),
}));

const threadRef = {
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("thread"),
};
const paths = ["screens/light.png", "dark.png", "clips/demo.mp4"];
function render(): ReactElement<ImageLightboxProps> {
  hooks.beginRender();
  return WorkspaceImageGallery({
    paths,
    initialIndex: 1,
    cwd: "/project",
    threadRef,
    onClose: vi.fn(),
  });
}

beforeEach(() => {
  hooks.reset();
  state.effects = [];
  state.createUrl.mockReset();
  state.search.mockReset();
  state.search.mockResolvedValue({
    _tag: "Success",
    value: { entries: [{ path: "screens/dark.png", kind: "file" }] },
  });
  state.createUrl.mockImplementation(
    async ({ input }: { input: { resource: { path: string } } }) => ({
      _tag: "Success",
      value: { relativeUrl: `/api/assets/signed/${input.resource.path}` },
    }),
  );
});

// Flush the finite promise chain: basename lookup, asset request, then the state update.
async function finishRequests() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

it("loads a message's images from the thread environment and resolves bare filenames", async () => {
  expect(render().props.images.every((image) => image.loading)).toBe(true);
  expect(state.createUrl).not.toHaveBeenCalled();
  state.effects[0]!();
  await finishRequests();
  expect(state.createUrl).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: {
      resource: { _tag: "workspace-file", threadId: threadRef.threadId, path: "screens/dark.png" },
    },
  });
  const gallery = render();
  expect(gallery.props.initialIndex).toBe(1);
  expect(gallery.props.images[2]?.kind).toBe("video");
  expect(gallery.props.images.map((image) => image.src)).toEqual([
    "https://remote.example/api/assets/signed/screens/light.png",
    "https://remote.example/api/assets/signed/screens/dark.png",
    "https://remote.example/api/assets/signed/clips/demo.mp4",
  ]);
});

it("retains image positions when one file is unavailable", async () => {
  state.createUrl.mockResolvedValueOnce({ _tag: "Failure" });
  render();
  state.effects[0]!();
  await finishRequests();
  const gallery = render();
  expect(gallery.props.images[0]).toMatchObject({ name: "light.png", src: "", loading: false });
  expect(gallery.props.images[1]?.src).toContain("screens/dark.png");
  expect(gallery.props.initialIndex).toBe(1);
});

it("ignores requests that finish after the gallery closes", async () => {
  render();
  const cleanup = state.effects[0]!();
  cleanup();
  await finishRequests();
  expect(render().props.images.every((image) => image.loading)).toBe(true);
});
