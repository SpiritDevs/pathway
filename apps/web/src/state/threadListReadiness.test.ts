import { Atom, AtomRegistry } from "effect/unstable/reactivity";
import { FocusId } from "@spiritdevs/contracts/focus";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../cloud/companyReadiness", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return { companyThreadReadinessAtom: Atom.make("loading") };
});
vi.mock("../cloud/focusReadModel", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return { activeFocusIdAtom: Atom.make("all"), focusReadModelReadinessAtom: Atom.make("loading") };
});
vi.mock("./shell", async () => {
  const { Atom } = await import("effect/unstable/reactivity");
  return { allEnvironmentShellsBootstrappedAtom: Atom.make(false) };
});

import { companyThreadReadinessAtom } from "../cloud/companyReadiness";
import { activeFocusIdAtom, focusReadModelReadinessAtom } from "../cloud/focusReadModel";
import { allEnvironmentShellsBootstrappedAtom } from "./shell";
import { threadListReadinessAtom } from "./threadListReadiness";

const registries: AtomRegistry.AtomRegistry[] = [];
function setup() {
  const registry = AtomRegistry.make();
  registries.push(registry);
  registry.mount(threadListReadinessAtom);
  return {
    read: () => registry.get(threadListReadinessAtom),
    // These are writable fixtures for production's derived atoms.
    company: (value: "loading" | "error" | "ready") =>
      registry.set(companyThreadReadinessAtom as Atom.Writable<typeof value>, value),
    shells: (value: boolean) =>
      registry.set(allEnvironmentShellsBootstrappedAtom as Atom.Writable<boolean>, value),
    focus: (value: "loading" | "error" | "ready") =>
      registry.set(focusReadModelReadinessAtom as Atom.Writable<typeof value>, value),
    select: (id: string) =>
      registry.set(activeFocusIdAtom, id === "all" ? "all" : FocusId.make(id)),
  };
}
afterEach(() => registries.splice(0).forEach((registry) => registry.dispose()));

describe("thread list readiness", () => {
  it("waits for company ownership and shells before showing an empty state", () => {
    const app = setup();
    expect(app.read()).toBe("loading");
    app.shells(true);
    expect(app.read()).toBe("loading");
    app.company("ready");
    expect(app.read()).toBe("ready");
  });
  it("keeps a selected Focus loading until its assignments arrive", () => {
    const app = setup();
    app.shells(true);
    app.company("ready");
    app.select("work");
    expect(app.read()).toBe("loading");
    app.focus("ready");
    expect(app.read()).toBe("ready");
    app.focus("error");
    expect(app.read()).toBe("error");
    app.select("all");
    expect(app.read()).toBe("ready");
    app.company("error");
    expect(app.read()).toBe("error");
  });
});
