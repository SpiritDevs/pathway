/** Cloud conversations use the existing device registrations and APNs delivery receipts. */
import { api } from "@spiritdevs/backend/convexApi";
import { RelayAgentAwarenessPreferences } from "@spiritdevs/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RelayConvexClient } from "../db.ts";
import { ApnsDeliveries } from "./ApnsDeliveries.ts";
import { LiveActivities } from "./LiveActivities.ts";
import type { TargetRow } from "./LiveActivities.ts";
import type { ApnsNotificationPayload } from "./apnsDeliveryJobs.ts";
const decodePreferences = Schema.decodeUnknownOption(
  Schema.fromJsonString(RelayAgentAwarenessPreferences),
);
export function orchestratorPushNotification(
  job: {
    chatId: string;
    subject: string;
    sequence: number;
    title: string;
    text: string;
    urgent: boolean;
  },
  target: TargetRow,
): ApnsNotificationPayload | null {
  const prefs = decodePreferences(target.preferences_json);
  if (
    target.user_id !== job.subject ||
    !target.push_token ||
    prefs._tag === "None" ||
    !prefs.value.notificationsEnabled ||
    !(job.urgent ? prefs.value.notifyOnInput : prefs.value.notifyOnCompletion)
  )
    return null;
  return {
    title: job.title,
    body: job.text,
    // Delivery receipts use a distinct namespace; native routing uses the explicit chat target.
    environmentId: "cloud-orchestrator",
    threadId: job.chatId,
    deepLink: "pathway://orchestrator",
    orchestrator: { accountID: job.subject, chatID: job.chatId, sequence: job.sequence },
  };
}
export const deliverOrchestratorNotifications = Effect.fn("relay.orchestrators.deliver")(
  function* () {
    const cloud = yield* RelayConvexClient;
    const devices = yield* LiveActivities;
    const deliveries = yield* ApnsDeliveries;
    const jobs = yield* cloud.mutation(api.aiOrchestratorPush.claim, {});
    for (const job of jobs) {
      yield* Effect.gen(function* () {
        const targets = yield* devices.listTargets({ userId: job.subject });
        for (const target of targets) {
          const notification = orchestratorPushNotification(job, target);
          if (!notification || !target.push_token) continue;
          yield* deliveries.sendPushNotification({
            target,
            token: target.push_token,
            sourceJobId: `orchestrator:${job.chatId}:${job.sequence}:${job.subject}:${target.device_id}`,
            notification,
          });
        }
        yield* cloud.mutation(api.aiOrchestratorPush.acknowledge, {
          chatId: job.chatId,
          subject: job.subject,
          sequence: job.sequence,
          generation: job.generation,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Orchestrator notification delivery will retry", { cause }),
        ),
      );
    }
  },
);
