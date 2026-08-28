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
const PERSONAL = FocusId.make("personal");
const HOBBIES = FocusId.make("hobbies");
const EMPTY = FocusId.make("empty");
const PROJECT = FocusProjectKey.make("environment-a:project-with-a-long-identifier");
const PERSONAL_PROJECT = FocusProjectKey.make("environment-a:personal-project");
const HOBBIES_PROJECT = FocusProjectKey.make("environment-a:hobbies-project");
const UNASSIGNED_PROJECT = FocusProjectKey.make("environment-a:unassigned-project");

const WORK_FOCUS: Focus = {
  id: WORK,
  name: "Work",
  iconName: "Briefcase",
  accentColor: "#3b82f6",
  orderKey: "a",
  createdAt: 1,
  updatedAt: 1,
};

function focus(id: FocusId, name: string, orderKey: string): Focus {
  return {
    id,
    name,
    iconName: "Circle",
    accentColor: "#64748b",
    orderKey,
    createdAt: 1,
    updatedAt: 1,
  };
}

const PERSONAL_FOCUS = focus(PERSONAL, "Personal", "b");
const HOBBIES_FOCUS = focus(HOBBIES, "Hobbies", "c");
const EMPTY_FOCUS = focus(EMPTY, "Empty", "d");

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
  it("keeps rows newest-first within groups and computes unread flags globally", () => {
    const groups = buildFocusNotificationRows({
      notifications: [
        notification("old-work", 10),
        notification("new-unassigned", 30, { projectKey: UNASSIGNED_PROJECT }),
        notification("mid-work", 20),
      ],
      unreadCount: 2,
      focuses: [WORK_FOCUS],
      assignments: [{ focusId: WORK, projectKey: PROJECT }],
      activeFocusId: WORK,
      threadTitlesByKey: new Map(),
      projectNamesByKey: new Map(),
    });

    expect(groups.map((group) => group.focusId)).toEqual([WORK, "all"]);
    expect(groups[0]?.rows.map((row) => [row.notification.id, row.unread])).toEqual([
      ["mid-work", true],
      ["old-work", false],
    ]);
    expect(groups[1]?.rows.map((row) => [row.notification.id, row.unread])).toEqual([
      ["new-unassigned", true],
    ]);
  });

  it("puts the active Focus first, keeps the others in strip order, and omits empty groups", () => {
    const groups = buildFocusNotificationRows({
      notifications: [
        notification("hobbies", 40, { projectKey: HOBBIES_PROJECT }),
        notification("work", 30),
        notification("personal", 20, { projectKey: PERSONAL_PROJECT }),
        notification("unassigned", 10, { projectKey: UNASSIGNED_PROJECT }),
      ],
      unreadCount: 0,
      focuses: [EMPTY_FOCUS, HOBBIES_FOCUS, PERSONAL_FOCUS, WORK_FOCUS],
      assignments: [
        { focusId: WORK, projectKey: PROJECT },
        { focusId: PERSONAL, projectKey: PERSONAL_PROJECT },
        { focusId: HOBBIES, projectKey: HOBBIES_PROJECT },
      ],
      activeFocusId: PERSONAL,
      threadTitlesByKey: new Map(),
      projectNamesByKey: new Map(),
    });

    expect(groups.map((group) => [group.focusId, group.focusName])).toEqual([
      [PERSONAL, "Personal"],
      [WORK, "Work"],
      [HOBBIES, "Hobbies"],
      ["all", "All"],
    ]);
  });

  it("resolves thread, project, and Focus context", () => {
    const item = notification("known", 10);
    const [group] = buildFocusNotificationRows({
      notifications: [item],
      unreadCount: 0,
      focuses: [WORK_FOCUS],
      assignments: [{ focusId: WORK, projectKey: PROJECT }],
      activeFocusId: WORK,
      threadTitlesByKey: new Map([[`${ENVIRONMENT}:${item.threadId}`, "Ship notifications"]]),
      projectNamesByKey: new Map([[PROJECT, "Pathway"]]),
    });

    expect(group?.rows[0]).toMatchObject({
      threadTitle: "Ship notifications",
      projectName: "Pathway",
      focusId: WORK,
      focusName: "Work",
    });
  });

  it("falls back to truncated ids and All for unassigned projects", () => {
    const [group] = buildFocusNotificationRows({
      notifications: [
        notification("fallback", 10, {
          threadId: ThreadId.make("thread-with-a-very-long-identifier"),
        }),
      ],
      unreadCount: 0,
      focuses: [WORK_FOCUS],
      assignments: [],
      activeFocusId: WORK,
      threadTitlesByKey: new Map(),
      projectNamesByKey: new Map(),
    });

    const row = group?.rows[0];
    expect(row?.threadTitle).toBe("thread-wit…ifier");
    expect(row?.projectName).toBe("project-wi…ifier");
    expect(row?.focusId).toBe("all");
    expect(row?.focusName).toBe("All");
  });
});
