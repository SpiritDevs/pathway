import { EnvironmentId } from "@spiritdevs/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentStorageIcon } from "./EnvironmentStorageIcon";
const state = vi.hoisted(() => ({
  pressure: "warning",
  last: null as { pressure: string } | null,
}));
vi.mock("@clerk/react", () => ({ useAuth: () => ({ userId: "test-user" }) }));
vi.mock("../../hooks/useStoragePressure", () => ({
  useStoragePressure: () => [
    { environment: { environmentId: "machine" }, pressure: state.pressure, last: state.last },
  ],
}));
const render = () =>
  renderToStaticMarkup(<EnvironmentStorageIcon environmentId={EnvironmentId.make("machine")} />);
describe("environment storage icon", () => {
  it("distinguishes low and critical storage, preserves last-known warnings, and hides healthy readings", () => {
    expect(render()).toContain('aria-label="Low storage"');
    expect(render()).toContain("text-warning");
    state.pressure = "critical";
    expect(render()).toContain('aria-label="Critical storage"');
    expect(render()).toContain("text-destructive");
    state.pressure = "unknown";
    state.last = { pressure: "critical" };
    expect(render()).toContain("Critical storage (last known)");
    state.pressure = "healthy";
    expect(render()).toBe("");
    state.pressure = "unknown";
    state.last = null;
    expect(render()).toBe("");
  });
});
