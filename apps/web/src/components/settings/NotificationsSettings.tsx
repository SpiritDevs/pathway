import { useAuth } from "@clerk/react";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useMemo, useState } from "react";
import {
  ALERT_EVENT_KEYS,
  alertProjectScopeKey,
  resolveAlertPolicy,
  type AlertPolicyOverride,
  type ThreadAlertSupport,
} from "@spiritdevs/contracts/threadAlerts";
import type { ClientSettings } from "@spiritdevs/contracts/settings";
import {
  getClientSettings,
  useClientSettings,
  useUpdateClientSettings,
} from "../../hooks/useSettings";
import { useProjects } from "../../state/entities";
import {
  threadAlertMutationsAtom,
  threadAlertPoliciesAtom,
  threadAlertPoliciesReadyAtom,
  threadAlertPoliciesErrorAtom,
} from "../../threadAlerts/state";
import { ALERT_EVENT_LABELS, policyChoices } from "../../threadAlerts/policyUi";
import {
  BUILT_IN_ALERT_SOUNDS,
  previewAlertSound,
  removeCustomAlertSound,
  saveCustomAlertSound,
} from "../../threadAlerts/audio";
import {
  getAlertNotificationSupport,
  requestAlertNotificationPermission,
  openAlertNotificationSettings,
  testThreadAlert,
} from "../../threadAlerts/delivery";
import { AlertPolicyChoices } from "../ThreadAlertBell";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

export function ProjectAlertOverride({ scopeKey, name }: { scopeKey: string; name: string }) {
  const policies = useAtomValue(threadAlertPoliciesAtom);
  const mutations = useAtomValue(threadAlertMutationsAtom);
  const policiesReady = useAtomValue(threadAlertPoliciesReadyAtom);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const choices = policyChoices(policies, "project", scopeKey);
  const inherited = resolveAlertPolicy(policyChoices(policies, "global", "global"));
  const save = async (next: AlertPolicyOverride) => {
    if (!mutations || !policiesReady || saving) return;
    setSaving(true);
    setError(null);
    try {
      await mutations.upsert({ scopeKind: "project", scopeKey, choices: next });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save project alerts.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="rounded-lg border border-border p-4 space-y-3">
      <h3 className="text-sm font-medium">{name}</h3>
      <AlertPolicyChoices
        choices={choices}
        inherited={inherited}
        disabled={!mutations || !policiesReady || policies === null || saving}
        onChange={(next) => void save(next)}
      />
      <Button
        size="sm"
        variant="ghost"
        disabled={!mutations || !policiesReady || saving || Object.keys(choices).length === 0}
        onClick={() => void save({})}
      >
        Use global defaults
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

export function NotificationsSettings() {
  const { userId } = useAuth();
  const settings = useClientSettings((value) => value.threadAlerts);
  const updateSettings = useUpdateClientSettings();
  const policies = useAtomValue(threadAlertPoliciesAtom);
  const mutations = useAtomValue(threadAlertMutationsAtom);
  const policiesReady = useAtomValue(threadAlertPoliciesReadyAtom);
  const policiesError = useAtomValue(threadAlertPoliciesErrorAtom);
  const projects = useProjects();
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [support, setSupport] = useState<ThreadAlertSupport | null>(null);
  const global = resolveAlertPolicy(policyChoices(policies, "global", "global"));
  const logicalProjects = useMemo(() => {
    const unique = new Map<string, string>();
    for (const project of projects)
      unique.set(
        alertProjectScopeKey(
          project.environmentId,
          project.id,
          project.repositoryIdentity?.canonicalKey,
        ),
        project.title,
      );
    return [...unique]
      .filter(([, name]) => name.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => a[1].localeCompare(b[1]));
  }, [projects, query]);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      void getAlertNotificationSupport()
        .then((value) => {
          if (active) setSupport(value);
        })
        .catch(() => {
          if (active) setSupport("unsupported");
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, []);
  const update = (patch: Partial<ClientSettings["threadAlerts"]>) =>
    updateSettings({ threadAlerts: { ...getClientSettings().threadAlerts, ...patch } });
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not update notifications.");
    } finally {
      setBusy(false);
    }
  };
  const quiet = settings.quietHours;
  return (
    <SettingsPageContainer>
      {error && (
        <p role="alert" className="px-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <SettingsSection id="thread-alerts" title="Thread alerts">
        <p className="px-3 text-sm text-muted-foreground">
          These defaults sync across your devices. Project and thread choices can override each
          event. Every event still appears in the Notification Tray.
        </p>
        {!policiesReady && (
          <p
            role={policiesError ? "alert" : "status"}
            className="px-3 text-sm text-muted-foreground"
          >
            {policiesError ?? "Loading thread alert settings..."}
            {policiesError
              ? " This device's sound and quiet hours settings are still available."
              : ""}
          </p>
        )}
        {ALERT_EVENT_KEYS.map((key) => (
          <SettingsRow
            key={key}
            title={ALERT_EVENT_LABELS[key]}
            control={
              <Switch
                aria-label={`${ALERT_EVENT_LABELS[key]} alerts`}
                checked={global[key]}
                disabled={!mutations || !policiesReady || policies === null || busy}
                onCheckedChange={(enabled) =>
                  void run(async () => {
                    if (!policiesReady) return;
                    await mutations?.upsert({
                      scopeKind: "global",
                      scopeKey: "global",
                      choices: { ...global, [key]: enabled },
                    });
                  })
                }
              />
            }
          />
        ))}
      </SettingsSection>
      <SettingsSection id="alert-project-overrides" title="Project overrides">
        <p className="px-3 text-sm text-muted-foreground">
          Repository choices cover matching worktrees and environments.
        </p>
        <input
          aria-label="Search project alert overrides"
          placeholder="Search projects"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="mx-3 h-9 w-[calc(100%-1.5rem)] rounded-md border border-input bg-background px-3 text-sm"
        />
        <div className="space-y-3 px-3">
          {logicalProjects.map(([key, name]) => (
            <ProjectAlertOverride key={key} scopeKey={key} name={name} />
          ))}
          {logicalProjects.length === 0 && (
            <p className="text-sm text-muted-foreground">No matching projects.</p>
          )}
        </div>
      </SettingsSection>
      <SettingsSection id="alert-device" title="This device">
        <p className="px-3 text-sm text-muted-foreground">
          Sound, OS notifications, and uploaded audio stay on this installation. Web alerts need
          this page to be running.
        </p>
        <SettingsRow
          title="Sound"
          control={
            <Switch
              aria-label="Alert sound"
              checked={settings.soundEnabled}
              onCheckedChange={(soundEnabled) => update({ soundEnabled })}
            />
          }
        />
        <SettingsRow
          title="Alert sound"
          control={
            <select
              aria-label="Selected alert sound"
              className="h-9 rounded-md border border-input bg-background px-2 text-sm"
              value={settings.soundId}
              onChange={(event) => update({ soundId: event.target.value })}
            >
              {BUILT_IN_ALERT_SOUNDS.map((sound) => (
                <option key={sound.id} value={sound.id}>
                  {sound.label}
                </option>
              ))}
              {settings.customSound && <option value="custom">{settings.customSound.name}</option>}
            </select>
          }
        />
        <SettingsRow
          title="Custom sound"
          description="MP3, WAV, M4A, OGG, or WebM. Up to 5 MB and 10 seconds. Missing files use System default."
        >
          <div className="flex flex-wrap items-center gap-2">
            <input
              aria-label="Upload alert sound"
              type="file"
              accept=".mp3,.wav,.m4a,.ogg,.webm,audio/*"
              disabled={!userId || busy}
              className="max-w-full text-sm"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file && userId)
                  void run(async () => {
                    const customSound = await saveCustomAlertSound(userId, file);
                    const previousSound = getClientSettings().threadAlerts.customSound;
                    update({ soundId: "custom", customSound });
                    if (previousSound && previousSound.id !== customSound.id) {
                      await removeCustomAlertSound(userId, previousSound.id);
                    }
                  });
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!userId || busy}
              onClick={() => {
                if (userId) void run(() => previewAlertSound(userId, settings));
              }}
            >
              Preview
            </Button>
            {settings.customSound && (
              <Button
                size="sm"
                variant="ghost"
                disabled={!userId || busy}
                onClick={() => {
                  const sound = settings.customSound;
                  if (userId && sound)
                    void run(async () => {
                      await removeCustomAlertSound(userId, sound.id);
                      update({
                        customSound: null,
                        soundId: settings.soundId === "custom" ? "system" : settings.soundId,
                      });
                    });
                }}
              >
                Remove
              </Button>
            )}
          </div>
        </SettingsRow>
        <SettingsRow
          title="OS notifications"
          description="Pathway posts silent OS notifications and plays the selected sound separately."
          control={
            <Switch
              aria-label="OS notifications"
              checked={settings.osNotificationsEnabled}
              disabled={busy}
              onCheckedChange={(enabled) => {
                update({ osNotificationsEnabled: enabled });
                if (enabled)
                  void run(async () => {
                    setSupport(await requestAlertNotificationPermission());
                  });
              }}
            />
          }
        />
        <SettingsRow
          title={`Permission: ${support === null ? "Checking" : support === "available" ? "Available" : support === "blocked" ? "Blocked" : "Unsupported"}`}
          description={
            support === "blocked"
              ? "OS notifications are currently off. Allow notifications in your browser's site permissions or system notification settings. Your preference is saved."
              : support === "unsupported"
                ? "This client cannot show OS notifications. Sound and the Notification Tray still work."
                : "Permission is requested only when you enable OS notifications here."
          }
          control={
            support === "blocked" ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  void run(async () => {
                    if (!(await openAlertNotificationSettings()))
                      setError(
                        "Open your browser's site settings and allow notifications for Pathway.",
                      );
                  })
                }
              >
                Open notification settings
              </Button>
            ) : undefined
          }
        />
        <SettingsRow
          title="Test alert"
          description="Uses enabled delivery channels and bypasses policy, quiet hours, and foreground suppression. Adds nothing to the tray."
          control={
            <Button
              variant="outline"
              disabled={!userId || busy}
              onClick={() => {
                if (userId) void run(() => testThreadAlert(userId, settings));
              }}
            >
              Test alert
            </Button>
          }
        />
      </SettingsSection>
      <SettingsSection id="alert-quiet-hours" title="Quiet hours">
        <SettingsRow
          title="Quiet hours"
          description={`Local timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}. One summary arrives afterwards for eligible events that remain unread.`}
          control={
            <Switch
              aria-label="Quiet hours"
              checked={quiet.enabled}
              onCheckedChange={(enabled) => update({ quietHours: { ...quiet, enabled } })}
            />
          }
        />
        <SettingsRow title="Days">
          <div className="flex flex-wrap gap-3">
            {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, index) => (
              <label key={day} className="flex items-center gap-1 text-sm">
                <input
                  type="checkbox"
                  aria-label={`Quiet hours on ${day}`}
                  checked={quiet.weekdays.includes(index)}
                  onChange={(event) =>
                    update({
                      quietHours: {
                        ...quiet,
                        weekdays: event.target.checked
                          ? [...quiet.weekdays, index].sort()
                          : quiet.weekdays.filter((value) => value !== index),
                      },
                    })
                  }
                />
                {day}
              </label>
            ))}
          </div>
        </SettingsRow>
        <SettingsRow title="Schedule">
          <div className="flex flex-wrap gap-4">
            {(["start", "end"] as const).map((key) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                {key === "start" ? "Start" : "End"}
                <input
                  aria-label={`Quiet hours ${key}`}
                  type="time"
                  value={quiet[key]}
                  className="rounded-md border border-input bg-background p-2"
                  onChange={(event) => {
                    if (event.target.value)
                      update({ quietHours: { ...quiet, [key]: event.target.value } });
                  }}
                />
              </label>
            ))}
          </div>
        </SettingsRow>
      </SettingsSection>
    </SettingsPageContainer>
  );
}
