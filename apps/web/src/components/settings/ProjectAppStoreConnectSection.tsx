import type { EnvironmentId } from "@spiritdevs/contracts";
import type { CompanyId } from "@spiritdevs/contracts/company";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import {
  appleAccountFunctions,
  useAppleAccountsClient,
  useAppleCloudQuery,
  type AppleProjectLink,
} from "~/cloud/appleAccounts";
import { readLocalApi } from "~/localApi";
import { appleEnvironment } from "~/state/apple";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { AppList } from "./AppleAccountsSettings";
import {
  APP_STORE_CONNECT_APPS_URL,
  completeProjectLinkPicker,
  describeAppleError,
  EMPTY_PROJECT_LINK_PICKER,
  pickProjectLinkAccount,
  pickProjectLinkApp,
  pickProjectLinkTeam,
} from "./AppleAccountsSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function reportError(title: string, error: unknown, fallback: string) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: describeAppleError(error, { fallback }).message,
    }),
  );
}

/**
 * Links a synced project to one App Store Connect app under a chosen Apple ID and team. Apps are
 * listed by `environmentId`, the environment that holds the project's checkout.
 */
export function ProjectAppStoreConnectSection({
  companyId,
  projectId,
  environmentId,
}: {
  companyId: CompanyId;
  projectId: string;
  environmentId: EnvironmentId;
}) {
  const client = useAppleAccountsClient();
  const link = useAppleCloudQuery(client, appleAccountFunctions.projectLink, {
    companyId,
    projectId,
  });
  return (
    <SettingsSection title="App Store Connect" id="app-store-connect">
      {link.error ? (
        <p role="alert" className="px-4 py-3 text-sm text-destructive">
          {describeAppleError(link.error, { fallback: "Could not load the linked app." }).message}
        </p>
      ) : link.data === undefined ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">Loading…</p>
      ) : link.data === null ? (
        <LinkPicker companyId={companyId} projectId={projectId} environmentId={environmentId} />
      ) : (
        <LinkedApp companyId={companyId} projectId={projectId} link={link.data} />
      )}
    </SettingsSection>
  );
}

function LinkedApp({
  companyId,
  projectId,
  link,
}: {
  companyId: CompanyId;
  projectId: string;
  link: AppleProjectLink;
}) {
  const client = useAppleAccountsClient();
  // Project readers may not see a personal Apple account; fall back to its stored IDs.
  const accounts = useAppleCloudQuery(client, appleAccountFunctions.listAccounts, { companyId });
  const teams = useAppleCloudQuery(client, appleAccountFunctions.listTeams, {
    accountId: link.accountId,
  });
  const account = accounts.data?.find((candidate) => candidate.id === link.accountId);
  const team = teams.data?.find((candidate) => candidate.teamId === link.teamId);
  const [busy, setBusy] = useState(false);
  const unlink = async () => {
    if (!client || busy) return;
    setBusy(true);
    try {
      await client.mutation(appleAccountFunctions.unlinkProject, { companyId, projectId });
    } catch (error) {
      reportError("Could not unlink app", error, "The app is still linked.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <SettingsRow
      title={link.app.name}
      description={
        <>
          <span className="font-mono">{link.app.bundleId}</span>
          {" · "}
          {account ? account.email : "Apple ID unavailable to you"}
          {" · "}
          {team ? `${team.name} (${team.teamId})` : link.teamId}
        </>
      }
      control={
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void unlink()}>
          Unlink
        </Button>
      }
    />
  );
}

function LinkPicker({
  companyId,
  projectId,
  environmentId,
}: {
  companyId: CompanyId;
  projectId: string;
  environmentId: EnvironmentId;
}) {
  const client = useAppleAccountsClient();
  const [picker, setPicker] = useState(EMPTY_PROJECT_LINK_PICKER);
  const [busy, setBusy] = useState(false);
  const accounts = useAppleCloudQuery(client, appleAccountFunctions.listAccounts, { companyId });
  const teams = useAppleCloudQuery(
    client,
    appleAccountFunctions.listTeams,
    picker.accountId === null ? null : { accountId: picker.accountId },
  );
  const apps = useEnvironmentQuery(
    picker.accountId === null || picker.teamId === null
      ? null
      : appleEnvironment.listApps({
          environmentId,
          input: { companyId, accountId: picker.accountId, teamId: picker.teamId },
        }),
  );
  const complete = completeProjectLinkPicker(picker);
  const accountList = accounts.data ?? [];
  const teamList = teams.data ?? [];
  const link = async () => {
    if (!client || !complete || busy) return;
    setBusy(true);
    try {
      await client.action(appleAccountFunctions.linkProject, { companyId, projectId, ...complete });
    } catch (error) {
      reportError("Could not link app", error, "The app was not linked.");
    } finally {
      setBusy(false);
    }
  };

  if (accounts.error) {
    return (
      <p role="alert" className="px-4 py-3 text-sm text-destructive">
        {describeAppleError(accounts.error, { fallback: "Could not load Apple accounts." }).message}
      </p>
    );
  }
  if (accounts.data !== undefined && accountList.length === 0) {
    return (
      <p className="px-4 py-3 text-sm text-muted-foreground">
        Add an Apple ID and connect a team's API key in Settings → Apple accounts to link an app.
      </p>
    );
  }
  return (
    <div className="space-y-3 px-4 py-3">
      <p className="text-sm text-muted-foreground">
        Link this project to an app in App Store Connect. Everyone who can see this project sees the
        linked app; reading builds still needs access to the Apple ID.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          value={picker.accountId}
          disabled={busy}
          onValueChange={(value) => setPicker(pickProjectLinkAccount(picker, value))}
        >
          <SelectTrigger aria-label="Apple ID">
            <SelectValue placeholder="Choose an Apple ID">
              {accountList.find((account) => account.id === picker.accountId)?.email}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {accountList.map((account) => (
              <SelectItem key={account.id} value={account.id}>
                {account.email}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        <Select
          value={picker.teamId}
          disabled={busy || picker.accountId === null || teamList.length === 0}
          onValueChange={(value) => setPicker(pickProjectLinkTeam(picker, value))}
        >
          <SelectTrigger aria-label="Developer team">
            <SelectValue
              placeholder={
                picker.accountId !== null && teams.data?.length === 0 ? "No teams" : "Choose a team"
              }
            >
              {teamList.find((team) => team.teamId === picker.teamId)?.name}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {teamList.map((team) => (
              <SelectItem key={team.teamId} value={team.teamId}>
                {team.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      {teams.error ? (
        <p role="alert" className="text-xs text-destructive">
          {describeAppleError(teams.error, { fallback: "Could not load teams." }).message}
        </p>
      ) : null}
      {picker.teamId !== null ? (
        <AppList
          title="Apps"
          apps={apps.data}
          error={apps.error}
          isPending={apps.isPending}
          onRefresh={apps.refresh}
          renderAction={(app) => (
            <Button
              size="xs"
              variant={picker.appId === app.id ? "default" : "outline"}
              disabled={busy}
              onClick={() => setPicker(pickProjectLinkApp(picker, app.id))}
            >
              {picker.appId === app.id ? "Selected" : "Select"}
            </Button>
          )}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={busy || complete === null} onClick={() => void link()}>
          {busy ? "Linking…" : "Link app"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            const api = readLocalApi();
            if (api) void api.shell.openExternal(APP_STORE_CONNECT_APPS_URL);
            else window.open(APP_STORE_CONNECT_APPS_URL, "_blank", "noopener,noreferrer");
          }}
        >
          Create a new app
          <ExternalLinkIcon />
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        New apps are created in App Store Connect. Once it is created, refresh the app list to link
        it here.
      </p>
    </div>
  );
}
