import { useEffect, useState, type FormEvent } from "react";
import type { EnvironmentId, ModelSelection } from "@spiritdevs/contracts";
import { createModelSelection } from "@spiritdevs/shared/model";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { ensureLocalApi } from "../../localApi";
import {
  getCustomModelOptionsByInstance,
  resolveAppModelSelectionState,
} from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsSection } from "../settings/settingsLayout";
import { useConnectedMailCloud, useMailQuery, type ConnectedMailCloud } from "./connectedMailCloud";
import type { ConnectedMailAccount, MailBrain } from "./connectedMail.types";

const modelValue = (selection: ModelSelection) => ({
  instanceId: selection.instanceId,
  model: selection.model,
  ...(selection.options ? { options: selection.options.map((option) => ({ ...option })) } : {}),
});

function BrainEditor({
  account,
  onSave,
}: {
  account: ConnectedMailAccount;
  onSave: (brain: MailBrain) => Promise<void>;
}) {
  const { environments } = useEnvironments();
  const primaryId = usePrimaryEnvironmentId();
  const [environmentId, setEnvironmentId] = useState(
    account.brain?.primaryEnvironmentId ?? primaryId ?? "",
  );
  const [backupId, setBackupId] = useState(account.brain?.backupEnvironmentId ?? "");
  const [selection, setSelection] = useState<ModelSelection | undefined>(account.brain?.selection);
  const [backupSelection, setBackupSelection] = useState<ModelSelection | undefined>(
    account.brain?.backupSelection,
  );
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const settings = useEnvironmentSettings((environmentId || null) as EnvironmentId | null);
  const backupSettings = useEnvironmentSettings((backupId || null) as EnvironmentId | null);
  const environment = environments.find((item) => item.environmentId === environmentId);
  const backup = environments.find((item) => item.environmentId === backupId);
  const providers = environment?.serverConfig?.providers ?? [];
  const backupProviders = backup?.serverConfig?.providers ?? [];
  const activeSelection = selection ?? resolveAppModelSelectionState(settings, providers);
  const primaryProvider = providers.find((item) => item.instanceId === activeSelection.instanceId);
  const matchingBackup = backupProviders.find(
    (item) =>
      item.driver === primaryProvider?.driver &&
      item.models.some((model) => model.slug === activeSelection.model),
  );
  const activeBackupSelection =
    backupSelection ??
    (matchingBackup
      ? createModelSelection(matchingBackup.instanceId, activeSelection.model)
      : resolveAppModelSelectionState(backupSettings, backupProviders));
  const supported = (driverKind: string | undefined) =>
    Boolean(driverKind && ["codex", "claudeAgent", "opencode"].includes(driverKind));
  const primarySupported = supported(primaryProvider?.driver);
  const backupSupported = supported(
    backupProviders.find((item) => item.instanceId === activeBackupSelection.instanceId)?.driver,
  );
  const picker = (isBackup: boolean) => {
    const current = isBackup ? activeBackupSelection : activeSelection;
    const config = isBackup ? backupSettings : settings;
    const available = isBackup ? backupProviders : providers;
    return (
      <ProviderModelPicker
        activeInstanceId={current.instanceId}
        model={current.model}
        lockedProvider={null}
        instanceEntries={sortProviderInstanceEntries(
          applyProviderInstanceSettings(
            deriveProviderInstanceEntries(available).filter((entry) =>
              ["codex", "claudeAgent", "opencode"].includes(entry.driverKind),
            ),
            config,
          ),
        )}
        modelOptionsByInstance={getCustomModelOptionsByInstance(
          config,
          available,
          current.instanceId,
          current.model,
        )}
        onInstanceModelChange={(instanceId, model) =>
          (isBackup ? setBackupSelection : setSelection)(createModelSelection(instanceId, model))
        }
        triggerAriaLabel={isBackup ? "Backup mail model" : "Mail model"}
        triggerVariant="outline"
      />
    );
  };
  return (
    <form
      className="grid gap-3 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        setSaving(true);
        setError(undefined);
        void onSave({
          primaryEnvironmentId: environmentId,
          selection: activeSelection,
          ...(backupId
            ? { backupEnvironmentId: backupId, backupSelection: activeBackupSelection }
            : {}),
        })
          .catch((cause: unknown) =>
            setError(cause instanceof Error ? cause.message : String(cause)),
          )
          .finally(() => setSaving(false));
      }}
    >
      <h3 className="text-sm font-medium">Mail analysis</h3>
      <p className="text-xs text-muted-foreground">
        Every message gets a bucket and a reason. Priority messages get a briefing. If both
        environments are offline, analysis waits while mail keeps arriving.
      </p>
      <label className="grid gap-1 text-xs">
        Primary environment
        <select
          className="rounded border bg-background p-2"
          value={environmentId}
          onChange={(event) => {
            setEnvironmentId(event.target.value);
            setSelection(undefined);
          }}
          required
        >
          <option value="">Choose an environment</option>
          {environments.map((item) => (
            <option key={item.environmentId} value={item.environmentId}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      {environmentId ? picker(false) : null}
      <label className="grid gap-1 text-xs">
        Backup environment
        <select
          className="rounded border bg-background p-2"
          value={backupId}
          onChange={(event) => {
            setBackupId(event.target.value);
            setBackupSelection(undefined);
          }}
        >
          <option value="">No backup</option>
          {environments
            .filter((item) => item.environmentId !== environmentId)
            .map((item) => (
              <option key={item.environmentId} value={item.environmentId}>
                {item.label}
              </option>
            ))}
        </select>
      </label>
      {backupId ? picker(true) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <Button
        type="submit"
        size="sm"
        disabled={
          saving ||
          !environment?.serverConfig ||
          !primarySupported ||
          Boolean(backupId && !backupSupported) ||
          Boolean(backupId && !backup?.serverConfig) ||
          backupId === environmentId
        }
      >
        {saving ? "Saving…" : "Save analysis settings"}
      </Button>
      {!primarySupported && environment?.serverConfig ? (
        <p className="text-xs text-muted-foreground">
          Choose Codex, Claude, or OpenCode for mail analysis.
        </p>
      ) : null}
      {!environment?.serverConfig ? (
        <p className="text-xs text-muted-foreground">
          Connect the primary environment to choose its model.
        </p>
      ) : null}
    </form>
  );
}

function SenderRules({ cloud, accountId }: { cloud: ConnectedMailCloud; accountId: string }) {
  const rules = useMailQuery<{ email: string; bucket: "priority" | "noise" }[]>(
    cloud.client,
    cloud.scope,
    "mail:listSenderRules",
    { companyId: cloud.companyId!, accountId },
  );
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <details className="text-xs">
      <summary>Sender rules</summary>
      <p className="my-2 text-muted-foreground">
        Removing a rule lets the model classify future messages from that sender.
      </p>
      {rules.value?.map((rule) => (
        <div className="flex items-center gap-2 py-1" key={rule.email}>
          <span className="min-w-0 flex-1 truncate">
            {rule.email} · {rule.bucket}
          </span>
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(undefined);
              void cloud
                .request("mail:removeSenderRule", { accountId, email: rule.email })
                .catch((cause: unknown) =>
                  setError(cause instanceof Error ? cause.message : String(cause)),
                )
                .finally(() => setBusy(false));
            }}
          >
            Remove
          </Button>
        </div>
      ))}
      {rules.value?.length === 0 ? <p className="text-muted-foreground">No sender rules.</p> : null}
      {error || rules.error ? (
        <p role="alert" className="text-destructive">
          {error ?? rules.error}
        </p>
      ) : null}
    </details>
  );
}

export function ConnectedMailSettings() {
  const cloud = useConnectedMailCloud();
  const result = useMailQuery<ConnectedMailAccount[]>(
    cloud.client,
    cloud.scope,
    "mail:listAccounts",
    cloud.ready ? { companyId: cloud.companyId! } : null,
  );
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const [disconnectId, setDisconnectId] = useState<string>();
  const [hostedEnabled, setHostedEnabled] = useState(false);
  const [configStatus, setConfigStatus] = useState<"loading" | "ready" | "failed">("loading");
  const [configRetry, setConfigRetry] = useState(0);
  const [credentialSource, setCredentialSource] = useState<"byo" | "hosted">("byo");
  useEffect(() => {
    let cancelled = false;
    setHostedEnabled(false);
    setConfigStatus("loading");
    setCredentialSource("byo");
    if (cloud.ready)
      void cloud
        .relay<{ hostedOAuthEnabled: boolean }>("config", {}, "GET")
        .then((config) => {
          if (!cancelled) {
            setHostedEnabled(config.hostedOAuthEnabled);
            setConfigStatus("ready");
          }
        })
        .catch(() => {
          if (!cancelled) setConfigStatus("failed");
        });
    return () => {
      cancelled = true;
    };
    // Owner and workspace define the capability request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cloud.scope, cloud.ready, configRetry]);

  const run = async (operation: () => Promise<unknown>) => {
    setPending(true);
    setError(undefined);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(false);
    }
  };
  const desktop = Boolean(window.desktopBridge);
  const connect = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (configStatus !== "ready") return;
    const form = event.currentTarget;
    const fields = new FormData(form);
    const popup = window.open("about:blank", "_blank");
    if (!popup) {
      setError("Allow popups to connect Gmail, then retry.");
      return;
    }
    popup.opener = null;
    void run(async () => {
      try {
        const { authorizationUrl } = await cloud.relay<{ authorizationUrl: string }>(
          "oauth/start",
          {
            credentialSource,
            ...(credentialSource === "byo"
              ? {
                  clientId: String(fields.get("clientId") ?? "").trim(),
                  clientSecret: String(fields.get("clientSecret") ?? "").trim(),
                }
              : {}),
            ...(String(fields.get("pubsubTopic") ?? "").trim()
              ? { pubsubTopic: String(fields.get("pubsubTopic")).trim() }
              : {}),
          },
        );
        form.reset();
        popup.location.replace(authorizationUrl);
      } catch (cause) {
        popup.close();
        throw cause;
      }
    });
  };
  return (
    <SettingsPageContainer>
      <SettingsSection title="Connected mail">
        <p className="mb-4 text-sm text-muted-foreground">
          Connect Gmail to receive private mail in this workspace. Pathway Connect keeps syncing
          when your environments are offline.
        </p>
        {!cloud.ready ? (
          <p className="text-sm">Sign in and select a Pathway Connect workspace to manage mail.</p>
        ) : (
          <>
            {configStatus === "failed" ? (
              <div className="mb-3 space-y-2">
                <p role="alert" className="text-sm text-destructive">
                  Mail service is unavailable. Check your connection and try again. If this
                  continues, ask your workspace administrator to check Pathway Connect.
                </p>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfigRetry((current) => current + 1)}
                >
                  Retry connection
                </Button>
              </div>
            ) : null}
            {configStatus === "loading" ? (
              <p role="status" className="mb-3 text-sm text-muted-foreground">
                Checking mail connection…
              </p>
            ) : null}
            {result.error || error ? (
              <p role="alert" className="mb-3 text-sm text-destructive">
                {error ?? result.error}
              </p>
            ) : null}
            {result.value?.map((account) => (
              <section key={account.id} className="mb-5 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="mr-auto text-sm font-medium">{account.email}</h3>
                  <span className="text-xs text-muted-foreground">
                    {account.status === "reauth_required"
                      ? "Reconnect required"
                      : account.status === "disconnected"
                        ? "Disconnected"
                        : account.lastSyncAt
                          ? "Connected"
                          : "Importing mail"}
                  </span>
                  {account.status !== "disconnected" ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={pending}
                      onClick={() => setDisconnectId(account.id)}
                    >
                      Disconnect
                    </Button>
                  ) : null}
                </div>
                {account.lastError ? (
                  <p className="text-xs text-destructive">{account.lastError}</p>
                ) : null}
                {disconnectId === account.id ? (
                  <div className="rounded border p-3 text-xs">
                    <p className="mb-2">
                      Disconnect this account and remove its copied messages, drafts, and private
                      sender knowledge from Pathway? Messages in Gmail are unaffected.
                    </p>
                    <div className="flex gap-2">
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => setDisconnectId(undefined)}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="xs"
                        disabled={pending}
                        onClick={() =>
                          void run(async () => {
                            await cloud.relay("disconnect", { accountId: account.id });
                            setDisconnectId(undefined);
                          })
                        }
                      >
                        Disconnect account
                      </Button>
                    </div>
                  </div>
                ) : null}
                {account.brain ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={pending}
                    onClick={() =>
                      void run(() => cloud.request("mail:disableBrain", { accountId: account.id }))
                    }
                  >
                    Pause analysis
                  </Button>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Analysis is paused. Mail continues to arrive. Save analysis settings to enable
                    it.
                  </p>
                )}
                <SenderRules cloud={cloud} accountId={account.id} />
                <BrainEditor
                  key={`${account.id}:${JSON.stringify(account.brain)}`}
                  account={account}
                  onSave={async (brain) => {
                    await cloud.request("mail:configureBrain", {
                      accountId: account.id,
                      brain: {
                        primaryEnvironmentId: brain.primaryEnvironmentId,
                        selection: modelValue(brain.selection),
                        ...(brain.backupEnvironmentId
                          ? { backupEnvironmentId: brain.backupEnvironmentId }
                          : {}),
                        ...(brain.backupSelection
                          ? { backupSelection: modelValue(brain.backupSelection) }
                          : {}),
                      },
                    });
                  }}
                />
              </section>
            ))}
            {desktop ? (
              <div className="grid gap-3 rounded-lg border p-4">
                <h3 className="text-sm font-medium">Connect or reconnect Gmail</h3>
                <p className="text-xs text-muted-foreground">
                  Select the same workspace and complete Google sign-in on Pathway web, then return
                  here. Your connected mailbox appears automatically.
                </p>
                <Button
                  onClick={() =>
                    void run(() =>
                      ensureLocalApi().shell.openExternal(
                        "https://app.spiritdevs.com/settings/email",
                      ),
                    )
                  }
                >
                  Open Gmail setup on web
                </Button>
              </div>
            ) : (
              <form className="grid gap-3 rounded-lg border p-4" onSubmit={connect}>
                <h3 className="text-sm font-medium">Connect or reconnect Gmail</h3>
                {hostedEnabled ? (
                  <label className="grid gap-1 text-xs">
                    Google connection
                    <select
                      className="rounded border bg-background p-2"
                      value={credentialSource}
                      onChange={(event) =>
                        setCredentialSource(event.target.value === "hosted" ? "hosted" : "byo")
                      }
                    >
                      <option value="byo">Your OAuth client</option>
                      <option value="hosted">Pathway OAuth</option>
                    </select>
                  </label>
                ) : null}
                {credentialSource === "byo" ? (
                  <>
                    <p className="text-xs text-muted-foreground">
                      Use your Google Cloud OAuth web client. Add this authorized redirect URI to
                      that client:
                    </p>
                    <code className="break-all text-xs select-all">
                      {cloud.relayUrl}/v1/mail/oauth/callback
                    </code>
                    <label className="grid gap-1 text-xs">
                      OAuth client ID
                      <Input name="clientId" required autoComplete="off" />
                    </label>
                    <label className="grid gap-1 text-xs">
                      OAuth client secret
                      <Input name="clientSecret" type="password" required autoComplete="off" />
                    </label>
                    <label className="grid gap-1 text-xs">
                      Pub/Sub topic, optional
                      <Input
                        name="pubsubTopic"
                        placeholder="projects/your-project/topics/gmail"
                        autoComplete="off"
                      />
                    </label>
                    <p className="text-xs text-muted-foreground">
                      A topic in the same Google Cloud project enables instant delivery. Without
                      one, Pathway checks for mail every five minutes.
                    </p>
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    Connect securely using Pathway’s Google OAuth client.
                  </p>
                )}
                <Button type="submit" disabled={pending || configStatus !== "ready"}>
                  {pending ? "Connecting…" : "Continue with Google"}
                </Button>
              </form>
            )}
          </>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
