import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({ status: "loading" }));
vi.mock("@clerk/react", () => ({
  ClerkLoading: ({ children }: { children: ReactNode }) =>
    state.status === "loading" ? children : null,
  ClerkFailed: ({ children }: { children: ReactNode }) =>
    state.status === "error" ? children : null,
  ClerkLoaded: ({ children }: { children: ReactNode }) =>
    state.status === "ready" ? children : null,
}));

import { ClerkStartupBoundary } from "./ClerkStartupBoundary";

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
