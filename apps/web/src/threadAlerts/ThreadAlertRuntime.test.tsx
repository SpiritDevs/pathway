import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_ALERT_DELIVERY_SETTINGS,
  type ThreadAlertTarget,
} from "@spiritdevs/contracts/threadAlerts";
import { reactHookHarness as hooks } from "../test/reactHookHarness";

const callbacks = vi.hoisted(() => ({ navigate: vi.fn(), markRead: vi.fn(), toast: vi.fn() }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return {
    ...actual,
    useCallback: reactHookHarness.useCallback,
    useMemo: reactHookHarness.useMemo,
  };
});
vi.mock("react/compiler-runtime", async () => {
  const { reactHookHarness } = await import("../test/reactHookHarness");
  return { c: reactHookHarness.useMemoCache };
});
vi.mock("@clerk/react", () => ({ useAuth: () => ({ userId: "account", isSignedIn: true }) }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: (value: unknown) => value }));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => callbacks.navigate,
  useParams: () => ({}),
}));
vi.mock("../cloud/companyRegistryReplica", () => ({ companyRegistryReplicasAtom: new Map() }));
vi.mock("../cloud/agentThreadReadModel", () => ({ cloudAgentThreadCompanyId: () => null }));
vi.mock("../cloud/activeCompany", () => ({ activeCompanyIdAtom: "company" }));
vi.mock("../cloud/focusReadModel", () => ({
  activeFocusIdAtom: "focus",
  focusAssignmentsAtom: [],
  focusNotificationsAtom: [],
  focusMutationsAtom: { markNotificationRead: callbacks.markRead },
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: () => DEFAULT_ALERT_DELIVERY_SETTINGS,
  useClientSettingsHydrated: () => true,
}));
vi.mock("../state/projects", () => ({ environmentProjects: { projectsAtom: [] } }));
vi.mock("../state/threads", () => ({ environmentThreadShells: { threadShellsAtom: [] } }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { set: vi.fn() } }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: callbacks.toast } }));
vi.mock("./ThreadAlertHost", () => ({ ThreadAlertHost: () => null }));
vi.mock("./state", () => ({
  threadAlertAccountAtom: "account",
  threadAlertPolicyScopesAtom: null,
  threadAlertConnectedAtom: true,
  threadAlertNotificationsReadyAtom: true,
  threadAlertPoliciesAtom: [],
  threadAlertPoliciesReadyAtom: true,
}));

import { ThreadAlertRuntime } from "./ThreadAlertRuntime";

const target = { environmentId: "env", threadId: "thread", eventId: "event" };
function openNotification() {
  hooks.beginRender();
  const host = ThreadAlertRuntime() as ReactElement<{
    onNavigate: (target: ThreadAlertTarget) => Promise<void>;
  }>;
  return host.props.onNavigate(target);
}
beforeEach(() => {
  hooks.reset();
  callbacks.navigate.mockReset().mockResolvedValue(undefined);
  callbacks.markRead.mockReset().mockResolvedValue(undefined);
  callbacks.toast.mockReset();
});

describe("notification click navigation", () => {
  it("opens the thread before acknowledging only the selected event", async () => {
    let finishNavigation!: () => void;
    callbacks.navigate.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishNavigation = resolve;
      }),
    );
    const opened = openNotification();
    expect(callbacks.navigate).toHaveBeenCalledWith({
      to: "/threads/$environmentId/$threadId",
      params: { environmentId: "env", threadId: "thread" },
    });
    expect(callbacks.markRead).not.toHaveBeenCalled();
    finishNavigation();
    await opened;
    expect(callbacks.markRead).toHaveBeenCalledExactlyOnceWith("event");
    expect(callbacks.toast).not.toHaveBeenCalled();
  });
  it("reports navigation failure without acknowledging the event", async () => {
    callbacks.navigate.mockRejectedValueOnce(new Error("Route unavailable"));
    await openNotification();
    expect(callbacks.markRead).not.toHaveBeenCalled();
    expect(callbacks.toast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Could not open notification",
      description: "Route unavailable",
    });
  });
  it("reports a read failure separately after successful navigation", async () => {
    callbacks.markRead.mockRejectedValueOnce(new Error("Notification expired"));
    await openNotification();
    expect(callbacks.navigate).toHaveBeenCalledOnce();
    expect(callbacks.toast).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Could not mark notification as read",
      description: "Notification expired",
    });
  });
});
