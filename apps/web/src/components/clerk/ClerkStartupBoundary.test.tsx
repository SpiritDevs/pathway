import { act, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ status: "loading" }));
vi.mock("@clerk/react", () => ({
  ClerkLoading: ({ children }: { children: ReactNode }) =>
    state.status === "loading" ? children : null,
  ClerkFailed: ({ children }: { children: ReactNode }) =>
    state.status === "error" ? children : null,
  ClerkLoaded: ({ children }: { children: ReactNode }) =>
    state.status === "ready" ? children : null,
}));
vi.mock("@clerk/electron/react", () => ({
  ClerkProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@clerk/electron/passkeys", () => ({ passkeys: {} }));

import { ClerkStartupBoundary } from "./ClerkStartupBoundary";
import ElectronClerkProvider from "./ElectronClerkProvider";

const render = () =>
  renderToStaticMarkup(<ClerkStartupBoundary>Protected app</ClerkStartupBoundary>);

describe("Clerk startup", () => {
  beforeEach(() => {
    state.status = "loading";
  });

  it("shows account progress during startup", () => {
    const html = render();
    expect(html).toContain("Checking your account");
    expect(html).not.toContain("Protected app");
  });

  it("replaces a failed account check with a retry action", () => {
    state.status = "error";
    const html = render();
    expect(html).toContain("Unable to check your account");
    expect(html).toContain("Try again");
    expect(html).not.toContain("boot-spinner");
    expect(html).not.toContain("Protected app");
  });

  it("retains the primary client's existing auth gate", () => {
    state.status = "ready";
    expect(render()).toContain("Protected app");
  });
});

describe("desktop Clerk startup", () => {
  let renderer: ReactTestRenderer | undefined;
  const reload = vi.fn();

  beforeEach(() => {
    state.status = "error";
    reload.mockClear();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", { location: { reload } });
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it("shows one alert and a working retry action for a reported Clerk failure", async () => {
    await act(async () => {
      renderer = create(
        <ElectronClerkProvider publishableKey="pk_test_startup">
          Protected app
        </ElectronClerkProvider>,
      );
    });
    const contents = JSON.stringify(renderer!.toJSON());
    expect(contents).toContain("Unable to check your account");
    expect(contents).not.toContain("boot-spinner");
    expect(contents).not.toContain("Protected app");
    expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(1);
    expect(renderer!.root.findByType("p").children.join("")).toBe(
      "Pathway couldn't start its sign-in service. Check your connection and try again.",
    );
    const retry = renderer!.root.findByType("button");
    expect(retry.children.join("")).toBe("Try again");
    await act(async () => retry.props.onClick());
    expect(reload).toHaveBeenCalledOnce();
  });
});
