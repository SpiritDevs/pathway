import { EnvironmentId } from "@spiritdevs/contracts";
import { htmlRenderTheme } from "@spiritdevs/shared/htmlRender";
import { Pathway_CODE_DARK_THEME_COLORS } from "@spiritdevs/shared/themePalettes";
import { act, useEffect, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { AssetUrlState } from "~/assets/assetUrls";

const environmentId = EnvironmentId.make("remote-environment");
const htmlRender = {
  attachmentId: "thread-chart-html",
  title: "Chart",
  height: 420,
  heights: [[728, 420]] as Array<[number, number]>,
};
const theme = htmlRenderTheme(Pathway_CODE_DARK_THEME_COLORS, "dark");
let asset: AssetUrlState & { refresh?: () => void };
let mounts = 0;
const readAsset = vi.fn((_environmentId: unknown, _resource: unknown) => asset);
vi.mock("~/assets/assetUrls", () => ({
  useAssetUrlState: (environmentId: unknown, resource: unknown) =>
    readAsset(environmentId, resource),
}));
vi.mock("~/hooks/useHtmlRenderTheme", () => ({ useHtmlRenderTheme: () => theme }));
vi.mock("../ui/button", () => ({
  Button: (props: Record<string, unknown>) => <button {...props} />,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));
vi.mock("./HtmlRenderDocument", () => ({
  HtmlRenderDocument: (_props: {
    src: string;
    onLoad: () => void;
    onContentHeight: (height: number) => void;
  }) => {
    useEffect(() => {
      mounts++;
    }, []);
    return null;
  },
  openHtmlRenderUrl: vi.fn(),
}));
const { HtmlRenderFrame } = await import("./HtmlRenderFrame");
const { HtmlRenderDocument } = await import("./HtmlRenderDocument");
let renderer: ReactTestRenderer | undefined;
const view = () => (
  <HtmlRenderFrame environmentId={environmentId} htmlRender={htmlRender} onExpand={() => {}} />
);
const document = () => renderer!.root.findByType(HtmlRenderDocument);
beforeEach(() => {
  asset = { _tag: "Success", url: "https://connect.example/api/assets/first/Chart.html" };
  mounts = 0;
  readAsset.mockClear();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
async function mount() {
  await act(async () => {
    renderer = create(view(), { createNodeMock: () => ({ clientWidth: 728 }) });
  });
}

describe("HTML render URL lifecycle", () => {
  it("signs against the owning environment and keeps the document mounted when the query refreshes", async () => {
    await mount();
    expect(readAsset).toHaveBeenLastCalledWith(environmentId, {
      _tag: "attachment",
      attachmentId: htmlRender.attachmentId,
      fileName: "Chart.html",
      mimeType: "text/html",
      disposition: "inline",
    });
    asset = { _tag: "Success", url: "https://connect.example/api/assets/new-token/Chart.html" };
    await act(async () => renderer!.update(view()));
    expect(document().props.src).toContain("/first/");
    expect(mounts).toBe(1);
    // Reloading an old signed URL (including an expired response) uses the current token.
    await act(async () => document().props.onLoad());
    expect(document().props.src).toBe(asset.url);
    expect(mounts).toBe(2);
    await act(async () => document().props.onLoad());
    expect(mounts).toBe(2);
  });

  it("offers a reload even when signing succeeded but the iframe contains an HTTP error", async () => {
    await mount();
    await act(async () =>
      renderer!.root.findByProps({ "aria-label": "Reload page" }).props.onClick(),
    );
    expect(mounts).toBe(2);
    asset = { _tag: "Success", url: "https://connect.example/api/assets/fresh/Chart.html" };
    await act(async () => renderer!.update(view()));
    await act(async () =>
      renderer!.root.findByProps({ "aria-label": "Reload page" }).props.onClick(),
    );
    expect(document().props.src).toBe(asset.url);
    expect(mounts).toBe(3);
  });

  it("retries signing failures without changing the reserved height", async () => {
    const refresh = vi.fn();
    asset = { _tag: "Failure", refresh };
    await mount();
    expect(renderer!.root.findByType("div").props.style.height).toBe(420);
    await act(async () => renderer!.root.findByType("button").props.onClick());
    expect(refresh).toHaveBeenCalledTimes(1);
    asset = { _tag: "Success", url: "https://connect.example/api/assets/retried/Chart.html" };
    await act(async () => renderer!.update(view()));
    expect(document().props.src).toBe(asset.url);
  });

  it("fits client height and ignores height changes beyond the maximum", async () => {
    await mount();
    await act(async () => document().props.onContentHeight(430));
    expect(renderer!.root.findByType("div").props.style.height).toBe(430);
    await act(async () => document().props.onContentHeight(5000));
    expect(renderer!.root.findByType("div").props.style.height).toBe(2000);
    const calls = readAsset.mock.calls.length;
    await act(async () => document().props.onContentHeight(6000));
    // React may evaluate one equal-state update, but subsequent changes cannot keep rendering.
    const afterEqualUpdate = readAsset.mock.calls.length;
    expect(afterEqualUpdate - calls).toBeLessThanOrEqual(1);
    await act(async () => document().props.onContentHeight(7000));
    expect(readAsset.mock.calls.length).toBe(afterEqualUpdate);
    expect(mounts).toBe(1);
  });
});
