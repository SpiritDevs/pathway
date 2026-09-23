import type { EnvironmentId } from "@spiritdevs/contracts";
import type { ComponentProps } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { ProjectDirectoryField } from "./ProjectDirectoryField";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  browse: vi.fn((input: unknown) => input),
  attach: undefined as (() => void) | undefined,
}));
vi.mock("~/state/query", () => ({ useEnvironmentQuery: mocks.query }));
vi.mock("~/state/filesystem", () => ({ filesystemEnvironment: { browse: mocks.browse } }));
vi.mock("../ui/button", () => ({
  Button: ({ children, onClick, disabled }: ComponentProps<"button">) => {
    if (children === "Attach") mocks.attach = () => onClick?.({} as never);
    return <button disabled={disabled}>{children}</button>;
  },
}));

const environmentId = "remote" as EnvironmentId;
const ready = (parentPath: string, entries: Array<{ name: string; fullPath: string }> = []) => ({
  data: { parentPath, entries },
  error: null,
  isPending: false,
  refresh: vi.fn(),
});
const render = (props: Partial<ComponentProps<typeof ProjectDirectoryField>> = {}) =>
  renderToStaticMarkup(
    <ProjectDirectoryField
      environmentId={environmentId}
      platform="MacIntel"
      currentProjectCwd={null}
      value="~/"
      onChange={vi.fn()}
      {...props}
    />,
  );

beforeEach(() => {
  mocks.attach = undefined;
  mocks.query.mockReset();
  mocks.browse.mockClear();
  mocks.query.mockReturnValue(ready("/home/remote"));
});

describe("project directory attachment", () => {
  it("inspects the selected environment's absolute home path", () => {
    const confirm = vi.fn().mockResolvedValue(true);
    render({ onConfirm: confirm });
    mocks.attach?.();
    expect(confirm).toHaveBeenCalledWith("/home/remote", false);
    expect(mocks.browse).toHaveBeenCalledWith({ environmentId, input: { partialPath: "~/" } });
  });

  it("inspects an exact directory match using its resolved path", () => {
    mocks.query.mockReturnValue(
      ready("/home/remote", [{ name: "app", fullPath: "/home/remote/app" }]),
    );
    const confirm = vi.fn().mockResolvedValue(false);
    const change = vi.fn();
    render({ value: "~/app", onConfirm: confirm, onChange: change });
    mocks.attach?.();
    expect(confirm).toHaveBeenCalledWith("/home/remote/app", false);
    expect(change).not.toHaveBeenCalled();
  });

  it("preserves attachment callbacks in the other directory dialogs", () => {
    const change = vi.fn();
    render({ onChange: change });
    mocks.attach?.();
    expect(change).toHaveBeenCalledWith("~/", false);
  });

  it("does not offer Attach before a directory has been read", () => {
    mocks.query.mockReturnValue({ data: null, error: null, isPending: false, refresh: vi.fn() });
    render({ onConfirm: vi.fn() });
    expect(mocks.attach).toBeUndefined();
  });

  it("allows creating a missing directory when its typed path ends in a slash", () => {
    mocks.query.mockReturnValueOnce({
      data: null,
      error: "Missing directory",
      isPending: false,
      refresh: vi.fn(),
    });
    mocks.query.mockReturnValueOnce(ready("/home/remote"));
    const html = render({ value: "~/new/", onConfirm: vi.fn() });
    expect(mocks.browse).toHaveBeenLastCalledWith({ environmentId, input: { partialPath: "~/" } });
    expect(html).toContain("Create Directory");
    expect(html).not.toContain('disabled=""');
  });
});
