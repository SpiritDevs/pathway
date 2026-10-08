import {
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
} from "@spiritdevs/contracts";
import { describe, expect, it } from "vite-plus/test";

import { scheduleFromDraft, taskToDraft } from "./scheduledTasksSettings.logic";

const intervalTask: ScheduledTask = {
  id: ScheduledTaskId.make("scheduled-task:legacy"),
  title: "Nightly review",
  prompt: "Review current work",
  enabled: true,
  schedule: { type: "interval", everyMs: 3_600_000 },
  projectId: ProjectId.make("project"),
  threadId: null,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
};

describe("scheduled task drafts", () => {
  it("round-trips interval and fixed-time schedules", () => {
    expect(scheduleFromDraft(taskToDraft(intervalTask))).toEqual(intervalTask.schedule);
    const fixed: ScheduledTask = {
      ...intervalTask,
      schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
    };
    expect(scheduleFromDraft(taskToDraft(fixed))).toEqual(fixed.schedule);
  });
});

describe("webhook scheduled tasks", () => {
  const signature = { header: "x-signature", encoding: "base64", prefix: "" } as const;
  const webhookTask: ScheduledTask = {
    ...intervalTask,
    schedule: { type: "webhook", signature },
    webhook: { path: "/api/hooks/legacy-task/token", url: null, hasSecret: true },
  };

  it("keeps a stored secret when the secret field is left blank", () => {
    const draft = taskToDraft(webhookTask);
    expect(draft.scheduleMode).toBe("webhook");
    expect(draft.signatureSecret).toBe("");
    expect(scheduleFromDraft(draft)).toEqual({
      type: "webhook",
      signature,
      maxDeliveryAgeMinutes: null,
    });
    expect(scheduleFromDraft({ ...draft, signatureSecret: " new " })).toEqual({
      type: "webhook",
      signature: { ...signature, secret: "new" },
      maxDeliveryAgeMinutes: null,
    });
  });

  it("drops the signature when it is switched off and offers GitHub's settings", () => {
    const draft = taskToDraft({ ...webhookTask, schedule: { type: "webhook", signature: null } });
    expect(draft.signatureEnabled).toBe(false);
    expect(draft.signatureHeader).toBe("x-hub-signature-256");
    expect(scheduleFromDraft(draft)).toEqual({
      type: "webhook",
      signature: null,
      maxDeliveryAgeMinutes: null,
    });
  });

  it("round-trips the max age, treats blank as no limit, and rejects an invalid limit", () => {
    const draft = taskToDraft({
      ...webhookTask,
      schedule: { type: "webhook", signature: null, maxDeliveryAgeMinutes: 90 },
    });
    expect(draft.maxDeliveryAgeMinutes).toBe("90");
    expect(scheduleFromDraft(draft)).toMatchObject({ maxDeliveryAgeMinutes: 90 });
    for (const blank of ["", "  "]) {
      expect(scheduleFromDraft({ ...draft, maxDeliveryAgeMinutes: blank })).toMatchObject({
        maxDeliveryAgeMinutes: null,
      });
    }
    for (const invalid of ["0", "-5", "1.5", "abc", "1441"]) {
      expect(scheduleFromDraft({ ...draft, maxDeliveryAgeMinutes: invalid })).toBeNull();
    }
  });
});
