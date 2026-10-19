import { describe, it, expect } from "@effect/vitest";
import { orchestratorPushNotification } from "./OrchestratorNotifications.ts";
import type { TargetRow } from "./LiveActivities.ts";
const preferences = {
  liveActivitiesEnabled: false,
  notificationsEnabled: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnApproval: true,
  notifyOnFailure: true,
};
const target: TargetRow = {
  user_id: "owner",
  device_id: "phone",
  platform: "ios",
  ios_major_version: 18,
  app_version: "1",
  bundle_id: null,
  aps_environment: null,
  push_token: "test-token",
  push_to_start_token: null,
  preferences_json: JSON.stringify(preferences),
  activity_push_token: null,
  remote_start_queued_at: null,
  remote_started_at: null,
  ended_at: null,
  last_aggregate_json: null,
  last_live_activity_delivery_at: null,
};
const job = {
  subject: "owner",
  chatId: "chat",
  sequence: 8,
  title: "Chief",
  text: "Review is ready",
  urgent: false,
};
describe("orchestrator mobile delivery policy", () => {
  it("routes an unread completion to its account and continuing conversation", () => {
    expect(orchestratorPushNotification(job, target)).toMatchObject({
      title: "Chief",
      body: "Review is ready",
      orchestrator: { accountID: "owner", chatID: "chat", sequence: 8 },
    });
  });
  it("respects completion and urgent switches separately from live activities", () => {
    const device = {
      ...target,
      preferences_json: JSON.stringify({ ...preferences, notifyOnCompletion: false }),
    };
    expect(orchestratorPushNotification(job, device)).toBeNull();
    expect(orchestratorPushNotification({ ...job, urgent: true }, device)).not.toBeNull();
    expect(
      orchestratorPushNotification(
        { ...job, urgent: true },
        { ...device, preferences_json: JSON.stringify({ ...preferences, notifyOnInput: false }) },
      ),
    ).toBeNull();
  });
  it("does not send private content to another account or a disabled device", () => {
    expect(orchestratorPushNotification(job, { ...target, user_id: "colleague" })).toBeNull();
    expect(
      orchestratorPushNotification(job, {
        ...target,
        preferences_json: JSON.stringify({ ...preferences, notificationsEnabled: false }),
      }),
    ).toBeNull();
    expect(orchestratorPushNotification(job, { ...target, push_token: null })).toBeNull();
  });
});
