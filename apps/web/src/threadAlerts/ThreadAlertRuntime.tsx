import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import { useCallback, useMemo } from "react";
import { EnvironmentId, ThreadId } from "@spiritdevs/contracts";
import {
  alertEventKey,
  alertProjectScopeKey,
  alertThreadScopeKey,
  resolveAlertPolicy,
  type ThreadAlertTarget,
} from "@spiritdevs/contracts/threadAlerts";
import type { AlertDeliveryEvent } from "@spiritdevs/client-runtime/thread-alerts";
import { presentThreadShell } from "@spiritdevs/client-runtime/state/models";
import { companyRegistryReplicasAtom } from "../cloud/companyRegistryReplica";
import {
  cloudAgentThreadCompanyId,
  cloudEnvironmentProjectsFromReplicas,
  cloudEnvironmentThreadsFromReplicas,
} from "../cloud/agentThreadReadModel";
import { activeCompanyIdAtom } from "../cloud/activeCompany";
import {
  focusIdForThread,
  focusNotificationProjectKey,
} from "@spiritdevs/client-runtime/state/focuses";
import {
  activeFocusIdAtom,
  focusListAtom,
  focusAssignmentsAtom,
  focusMutationsAtom,
  focusNotificationsAtom,
} from "../cloud/focusReadModel";
import { useClientSettings, useClientSettingsHydrated } from "../hooks/useSettings";
import { environmentProjects } from "../state/projects";
import { environmentThreadShells } from "../state/threads";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { resolveThreadRouteRef } from "../threadRoutes";
import { toastManager } from "../components/ui/toast";
import { ThreadAlertHost } from "./ThreadAlertHost";
import {
  threadAlertAccountAtom,
  threadAlertPolicyScopesAtom,
  threadAlertConnectedAtom,
  threadAlertNotificationsReadyAtom,
  threadAlertPoliciesAtom,
  threadAlertPoliciesReadyAtom,
} from "./state";

export const OPEN_NOTIFICATION_TRAY_EVENT = "pathway:open-notification-tray";

export function ThreadAlertRuntime() {
  const { userId, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const settings = useClientSettings((value) => value.threadAlerts);
  const settingsReady = useClientSettingsHydrated();
  const rows = useAtomValue(focusNotificationsAtom);
  const policies = useAtomValue(threadAlertPoliciesAtom);
  const policyReady = useAtomValue(threadAlertPoliciesReadyAtom);
  const notificationsReady = useAtomValue(threadAlertNotificationsReadyAtom);
  const connected = useAtomValue(threadAlertConnectedAtom);
  const account = useAtomValue(threadAlertAccountAtom);
  const policyScopes = useAtomValue(threadAlertPolicyScopesAtom);
  const threads = useAtomValue(environmentThreadShells.threadShellsAtom);
  const replicas = useAtomValue(companyRegistryReplicasAtom);
  const projects = useAtomValue(environmentProjects.projectsAtom);
  const mutations = useAtomValue(focusMutationsAtom);
  const assignments = useAtomValue(focusAssignmentsAtom);
  const focuses = useAtomValue(focusListAtom);
  const activeFocusId = useAtomValue(activeFocusIdAtom);
  const focusIdByProjectKey = useMemo(
    () => new Map(assignments.map((assignment) => [assignment.projectKey, assignment.focusId])),
    [assignments],
  );
  const params = useParams({ strict: false });
  const focusedThread = resolveThreadRouteRef(params);
  const navigate = useNavigate();
  const eventEnvironmentIds = useMemo(
    () => [...new Set(rows.map((row) => row.environmentId))],
    [rows],
  );
  const threadMap = useMemo(() => {
    const result = new Map(
      threads.map((thread) => [alertThreadScopeKey(thread.environmentId, thread.id), thread]),
    );
    for (const environmentId of eventEnvironmentIds) {
      for (const thread of cloudEnvironmentThreadsFromReplicas(replicas, environmentId)) {
        const key = alertThreadScopeKey(environmentId, thread.id);
        if (!result.has(key)) result.set(key, presentThreadShell(environmentId, thread));
      }
    }
    return result;
  }, [threads, replicas, eventEnvironmentIds]);
  const projectMap = useMemo(() => {
    const result = new Map(
      projects.map((project) => [`${project.environmentId}:${project.id}`, project]),
    );
    for (const environmentId of eventEnvironmentIds) {
      for (const project of cloudEnvironmentProjectsFromReplicas(replicas, environmentId)) {
        const key = `${environmentId}:${project.id}`;
        if (!result.has(key)) result.set(key, { ...project, environmentId });
      }
    }
    return result;
  }, [projects, replicas, eventEnvironmentIds]);
  const policyMap = useMemo(
    () => new Map((policies ?? []).map((row) => [`${row.scopeKind}:${row.scopeKey}`, row.choices])),
    [policies],
  );
  const rowMap = useMemo(() => new Map(rows.map((row) => [row.eventId as string, row])), [rows]);
  const events = useMemo(
    () =>
      rows.map((row): AlertDeliveryEvent => {
        const thread = threadMap.get(alertThreadScopeKey(row.environmentId, row.threadId));
        const project = projectMap.get(row.projectKey);
        return {
          eventId: row.eventId,
          environmentId: row.environmentId,
          threadId: row.threadId,
          kind: row.eventKind,
          createdAt: row.createdAt,
          threadTitle: thread?.title ?? "Pathway thread",
          projectName: project?.title ?? "",
          alertEligibleAtCreation: row.alertEligibleAtCreation,
          ...(row.isRead === undefined ? {} : { isRead: row.isRead }),
        };
      }),
    [rows, threadMap, projectMap],
  );
  const isEligible = useCallback(
    (event: AlertDeliveryEvent) => {
      const threadKey = alertThreadScopeKey(event.environmentId, event.threadId);
      const thread = threadMap.get(threadKey);
      if (!thread) return null;
      if (thread.settledAt !== null || thread.archivedAt !== null || thread.deletedAt !== null)
        return false;
      const project = projectMap.get(`${thread.environmentId}:${thread.projectId}`);
      const projectKey =
        rowMap.get(event.eventId)?.alertProjectKey ??
        (thread.projectId === null
          ? null
          : alertProjectScopeKey(
              thread.environmentId,
              thread.projectId,
              project?.repositoryIdentity?.canonicalKey,
            ));
      if (
        !policyScopes?.threadKeys.includes(threadKey) ||
        (projectKey !== null && !policyScopes.projectKeys.includes(projectKey))
      )
        return null;
      return resolveAlertPolicy(
        policyMap.get("global:global"),
        projectKey === null ? undefined : policyMap.get(`project:${projectKey}`),
        policyMap.get(`thread:${threadKey}`),
      )[alertEventKey(event.kind)];
    },
    [threadMap, projectMap, policyMap, rowMap, policyScopes],
  );
  const onNavigate = useCallback(
    async (target: ThreadAlertTarget) => {
      if (target === null) {
        window.dispatchEvent(new Event(OPEN_NOTIFICATION_TRAY_EVENT));
        return;
      }
      if ("kind" in target) {
        await navigate({ to: "/settings/archived" });
        return;
      }
      const thread = threadMap.get(alertThreadScopeKey(target.environmentId, target.threadId));
      const companyId = cloudAgentThreadCompanyId(
        replicas,
        EnvironmentId.make(target.environmentId),
        target.threadId,
      );
      if (companyId !== null) appAtomRegistry.set(activeCompanyIdAtom, companyId);
      const notification = rowMap.get(target.eventId);
      const projectKey = thread
        ? thread.projectId === null
          ? null
          : `${target.environmentId}:${thread.projectId}`
        : notification
          ? focusNotificationProjectKey(notification)
          : undefined;
      appAtomRegistry.set(
        activeFocusIdAtom,
        focusIdForThread({ projectKey, activeFocusId, focuses, focusIdByProjectKey }),
      );
      try {
        await navigate({
          to: "/threads/$environmentId/$threadId",
          params: {
            environmentId: EnvironmentId.make(target.environmentId),
            threadId: ThreadId.make(target.threadId),
          },
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not open notification",
          description:
            error instanceof Error ? error.message : "Try opening it from the notification tray.",
        });
        return;
      }
      try {
        await mutations?.markNotificationRead?.(target.eventId);
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not mark notification as read",
          description:
            error instanceof Error
              ? error.message
              : "Try marking it read from the notification tray.",
        });
      }
    },
    [activeFocusId, focuses, focusIdByProjectKey, rowMap, threadMap, navigate, mutations, replicas],
  );
  if (!isSignedIn || !userId || account !== userId) return null;
  return (
    <ThreadAlertHost
      userId={userId}
      ready={settingsReady && notificationsReady && policyReady && policies !== null}
      connected={connected}
      notifications={events}
      settings={settings}
      focusedThread={focusedThread}
      isEligible={isEligible}
      onNavigate={onNavigate}
    />
  );
}
