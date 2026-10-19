import type { ReactElement } from "react";
import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import {
  AttentionEventId,
  FocusId,
  FocusNotificationId,
  FocusProjectKey,
} from "@spiritdevs/contracts/focus";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_ALERT_DELIVERY_SETTINGS,
  type ThreadAlertTarget,
} from "@spiritdevs/contracts/threadAlerts";
import { reactHookHarness as hooks } from "../test/reactHookHarness";

const callbacks = vi.hoisted(() => ({
  navigate: vi.fn(),
  markRead: vi.fn(),
  toast: vi.fn(),
  setAtom: vi.fn(),
  activeFocusId: "all",
  focuses: [] as Array<import("@spiritdevs/contracts/focus").Focus>,
  notifications: [] as Array<import("@spiritdevs/contracts/focus").FocusNotification>,
}));
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
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (value: unknown) => (value === "active-focus" ? callbacks.activeFocusId : value),
}));
vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => callbacks.navigate,
  useParams: () => ({}),
}));
vi.mock("../cloud/companyRegistryReplica", () => ({ companyRegistryReplicasAtom: new Map() }));
vi.mock("../cloud/agentThreadReadModel", () => ({
  cloudAgentThreadCompanyId: () => null,
  cloudEnvironmentProjectsFromReplicas: () => [],
  cloudEnvironmentThreadsFromReplicas: () => [],
}));
vi.mock("../cloud/activeCompany", () => ({ activeCompanyIdAtom: "company" }));
vi.mock("../cloud/focusReadModel", () => ({
  activeFocusIdAtom: "active-focus",
  focusAssignmentsAtom: [],
  get focusListAtom() {
    return callbacks.focuses;
  },
  get focusNotificationsAtom() {
    return callbacks.notifications;
  },
  focusMutationsAtom: { markNotificationRead: callbacks.markRead },
}));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: () => DEFAULT_ALERT_DELIVERY_SETTINGS,
  useClientSettingsHydrated: () => true,
}));
vi.mock("../state/projects", () => ({ environmentProjects: { projectsAtom: [] } }));
vi.mock("../state/threads", () => ({ environmentThreadShells: { threadShellsAtom: [] } }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: { set: callbacks.setAtom } }));
vi.mock("../components/ui/toast", () => ({ toastManager: { add: callbacks.toast } }));
vi.mock("./useReadThreadNotifications", () => ({ useReadThreadNotifications: () => {} }));
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
  callbacks.setAtom.mockReset();
  callbacks.activeFocusId = "all";
  callbacks.focuses = [];
  callbacks.notifications = [];
});

describe("notification click navigation", () => {
  it("opens Storage & cleanup for a native storage alert without touching a thread notification", async () => {
    hooks.beginRender();
    const host = ThreadAlertRuntime() as ReactElement<{
      onNavigate: (target: ThreadAlertTarget) => Promise<void>;
    }>;
    await host.props.onNavigate({ kind: "storage", environmentId: "env" });
    expect(callbacks.navigate).toHaveBeenCalledExactlyOnceWith({ to: "/settings/archived" });
    expect(callbacks.markRead).not.toHaveBeenCalled();
    expect(callbacks.setAtom).not.toHaveBeenCalled();
  });
  it.each([true, false])(
    "opens Conversations regardless of the selected Focus setting (%s)",
    async (includeConversations) => {
      callbacks.activeFocusId = "work";
      callbacks.focuses = [
        {
          id: FocusId.make("work"),
          name: "Work",
          iconName: "Circle",
          accentColor: "#64748b",
          orderKey: "a",
          createdAt: 1,
          updatedAt: 1,
          includeConversations,
        },
      ];
      callbacks.notifications = [
        {
          id: FocusNotificationId.make("notification"),
          alertEligibleAtCreation: true,
          eventId: AttentionEventId.make("event"),
          environmentId: EnvironmentId.make("env"),
          threadId: ThreadId.make("thread"),
          projectKey: FocusProjectKey.make("env:conversations"),
          eventKind: "finished-unsettled",
          createdAt: 1,
        },
      ];
      await openNotification();
      expect(callbacks.setAtom).toHaveBeenCalledWith("active-focus", "conversations");
      expect(callbacks.markRead).toHaveBeenCalledWith("event");
    },
  );

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
