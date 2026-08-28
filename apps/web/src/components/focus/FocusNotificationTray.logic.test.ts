import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import {
  AttentionEventId,
  FocusId,
  FocusNotificationId,
  FocusProjectKey,
  type AttentionEventKind,
  type Focus,
  type FocusNotification,
} from "@spiritdevs/contracts/focus";
import { describe, expect, it } from "vite-plus/test";

import {
  buildFocusNotificationRows,
  focusNotificationEventLabel,
} from "./FocusNotificationTray.logic";

const ENVIRONMENT = EnvironmentId.make("environment-a");
const WORK = FocusId.make("work");
const PROJECT = FocusProjectKey.make("environment-a:project-with-a-long-identifier");

const WORK_FOCUS: Focus = {
  id: WORK,
  name: "Work",
  iconName: "Briefcase",
  accentColor: "#3b82f6",
  orderKey: "n",
  createdAt: 1,
  updatedAt: 1,
};

function notification(
  id: string,
  createdAt: number,
  overrides: Partial<FocusNotification> = {},
): FocusNotification {
  return {
    id: FocusNotificationId.make(id),
    eventId: AttentionEventId.make(id),
    environmentId: ENVIRONMENT,
    threadId: ThreadId.make(`thread-${id}`),
    projectKey: PROJECT,
    eventKind: "finished-unsettled",
    createdAt,
    ...overrides,
  };
}

describe("Focus notification labels", () => {
  it.each([
    ["finished-unsettled", "Finished"],
    ["pending-approval", "Needs approval"],
    ["awaiting-input", "Waiting for input"],
    ["failed", "Failed"],
  ] satisfies ReadonlyArray<readonly [AttentionEventKind, string]>)(
    "maps %s to %s",
    (eventKind, label) => {
      expect(focusNotificationEventLabel(eventKind)).toBe(label);
    },
  );
});

describe("Focus notification rows", () => {
  it("orders newest first and marks the newest unread rows", () => {
    const rows = buildFocusNotificationRows({
      notifications: [notification("old", 10), notification("new", 30), notification("mid", 20)],
      unreadCount: 2,
      focuses: [WORK_FOCUS],
      assignments: [{ focusId: WORK, projectKey: PROJECT }],
      threadTitlesByKey: new Map(),
      projectNamesByKey: new Map(),
    });

    expect(rows.map((row) => row.notification.id)).toEqual(["new", "mid", "old"]);
    expect(rows.map((row) => row.unread)).toEqual([true, true, false]);
  });

  it("resolves thread, project, and Focus context", () => {
    const item = notification("known", 10);
    const [row] = buildFocusNotificationRows({
      notifications: [item],
      unreadCount: 0,
      focuses: [WORK_FOCUS],
      assignments: [{ focusId: WORK, projectKey: PROJECT }],
      threadTitlesByKey: new Map([[`${ENVIRONMENT}:${item.threadId}`, "Ship notifications"]]),
      projectNamesByKey: new Map([[PROJECT, "Pathway"]]),
    });

    expect(row).toMatchObject({
      threadTitle: "Ship notifications",
      projectName: "Pathway",
      focusId: WORK,
      focusName: "Work",
    });
  });

  it("falls back to truncated ids and All for unassigned projects", () => {
    const [row] = buildFocusNotificationRows({
      notifications: [
        notification("fallback", 10, {
          threadId: ThreadId.make("thread-with-a-very-long-identifier"),
        }),
      ],
      unreadCount: 0,
      focuses: [WORK_FOCUS],
      assignments: [],
      threadTitlesByKey: new Map(),
      projectNamesByKey: new Map(),
    });

    expect(row?.threadTitle).toBe("thread-wit…ifier");
    expect(row?.projectName).toBe("project-wi…ifier");
    expect(row?.focusId).toBe("all");
    expect(row?.focusName).toBe("All");
  });
});
