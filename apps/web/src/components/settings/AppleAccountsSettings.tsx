import type { AppleTarget } from "@spiritdevs/contracts/apple";
import type { CompanyId } from "@spiritdevs/contracts/company";
import type { EnvironmentId } from "@spiritdevs/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { PlusIcon, RefreshCwIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  appleAccountFunctions,
  useAppleAccountsClient,
  useAppleCloudQuery,
  type AppleAccount,
  type AppleTeam,
} from "~/cloud/appleAccounts";
import { appleEnvironment } from "~/state/apple";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { cn } from "~/lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { CompanySettingsEmptyState } from "./company/CompanySettingsShared";
import { useCompanySettings } from "./company/useCompanySettings";
import {
  APPLE_CONFLICT_MESSAGE,
  APPLE_TEAM_ID_PATTERN,
  APPLE_TEAM_TYPES,
  describeAppleError,
  EMPTY_KEY_DRAFT,
  ENVIRONMENT_KEY_STATE_LABELS,
  environmentHealthRows,
  keyDraftProblem,
  keySummary,
  normalizeTeamId,
  scopeLabel,
  type AppleTeamType,
  type KeyDraft,
} from "./AppleAccountsSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

function reportAppleError(
  title: string,
  error: unknown,
  options: { fallback: string; conflictMessage?: string },
) {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: describeAppleError(error, options).message,
    }),
  );
}

function relativeTime(epochMs: number | null): string {
  return epochMs === null ? "never" : formatRelativeTimeLabel(new Date(epochMs).toISOString());
}

/** The company this environment authorizes Apple reads for, and a display name for tethering. */
interface AppleCompanyContext {
  readonly companyId: CompanyId | null;
  /** Set only for organization workspaces; personal workspaces have nothing to tether to. */
  readonly tetherCompany: { readonly id: CompanyId; readonly name: string } | null;
  readonly companyName: (companyId: string) => string | undefined;
}

export function AppleAccountsSettings() {
  const settings = useCompanySettings();
  const client = useAppleAccountsClient();
  const context = useMemo<AppleCompanyContext>(
    () => ({
      companyId: settings.companyId,
      tetherCompany:
        settings.activeCompany?.workspaceKind === "organization" && settings.companyId !== null
          ? { id: settings.companyId, name: settings.activeCompany.name }
          : null,
      companyName: (companyId) =>
        settings.companies.find((company) => company.id === companyId)?.name,
    }),
    [settings.activeCompany, settings.companies, settings.companyId],
  );
  const accounts = useAppleCloudQuery(
    client,
    appleAccountFunctions.listAccounts,
    context.tetherCompany ? { companyId: context.tetherCompany.id } : {},
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const list = accounts.data ?? [];
  const selected = list.find((account) => account.id === selectedId) ?? list[0] ?? null;

  if (settings.isAuthLoaded && !settings.isSignedIn) {
    return (
      <SettingsPageContainer>
        <CompanySettingsEmptyState
          title="Sign in to manage Apple accounts"
          description="Apple IDs, Developer teams and App Store Connect keys are stored in your Pathway account."
        />
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection
        title="Apple accounts"
        id="apple-accounts"
        headerAction={
          <Button size="sm" variant="outline" onClick={() => setAdding(true)} disabled={!client}>
            <PlusIcon className="size-3.5" />
            Add Apple ID
          </Button>
        }
      >
        <div className="space-y-3 px-4 py-3">
          <p className="text-sm text-muted-foreground">
            Apple IDs, their Developer teams and App Store Connect API keys sync to every
            environment you use. An Apple ID is personal unless you share it with a company.
          </p>
          {adding && client ? (
            <AddAccountForm
              context={context}
              onDone={(account) => {
                setAdding(false);
                if (account) setSelectedId(account.id);
              }}
            />
          ) : null}
          {accounts.error ? (
            <p role="alert" className="text-sm text-destructive">
              {
                describeAppleError(accounts.error, { fallback: "Could not load Apple accounts." })
                  .message
              }
            </p>
          ) : accounts.data === undefined ? (
            <p className="text-sm text-muted-foreground">Loading Apple accounts…</p>
          ) : list.length === 0 && !adding ? (
            <p className="text-sm text-muted-foreground">
              No Apple IDs yet. Add one to connect its Developer teams.
            </p>
          ) : null}
          {list.length > 0 ? (
            <div className="grid gap-3 md:grid-cols-[minmax(12rem,16rem)_1fr]">
              <ul className="space-y-1" aria-label="Apple IDs">
                {list.map((account) => (
                  <li key={account.id}>
                    <button
                      type="button"
                      aria-current={account.id === selected?.id}
                      onClick={() => setSelectedId(account.id)}
                      className={cn(
                        "w-full rounded-md border px-3 py-2 text-left text-sm hover:bg-accent/50",
                        account.id === selected?.id
                          ? "border-primary/40 bg-accent/50"
                          : "border-transparent",
                      )}
                    >
                      <span className="block truncate font-medium">{account.displayName}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {account.email}
                      </span>
                      <Badge variant="outline" size="sm" className="mt-1">
                        {scopeLabel(account.scope, context.companyName)}
                      </Badge>
                    </button>
                  </li>
                ))}
              </ul>
              {selected ? (
                <AccountDetail key={selected.id} account={selected} context={context} />
              ) : null}
            </div>
          ) : null}
        </div>
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function AddAccountForm({
  context,
  onDone,
}: {
  context: AppleCompanyContext;
  onDone: (account: AppleAccount | null) => void;
}) {
  const client = useAppleAccountsClient();
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [shareWithCompany, setShareWithCompany] = useState(false);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!client || busy) return;
    setBusy(true);
    try {
      const account = await client.mutation(appleAccountFunctions.createAccount, {
        email: email.trim(),
        displayName: displayName.trim() || email.trim(),
        ...(shareWithCompany && context.tetherCompany
          ? { scope: { kind: "company" as const, companyId: context.tetherCompany.id } }
          : {}),
      });
      onDone(account);
    } catch (error) {
      reportAppleError("Could not add Apple ID", error, {
        fallback: "The Apple ID was not added.",
      });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="grid gap-3 rounded-md border p-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="space-y-1 text-xs">
        Apple ID email
        <Input
          required
          type="email"
          autoComplete="off"
          disabled={busy}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </label>
      <label className="space-y-1 text-xs">
        Display name
        <Input
          disabled={busy}
          placeholder="Optional"
          value={displayName}
          maxLength={200}
          onChange={(event) => setDisplayName(event.target.value)}
        />
      </label>
      {context.tetherCompany ? (
        <label className="flex items-center gap-2 text-xs sm:col-span-2">
          <input
            type="checkbox"
            checked={shareWithCompany}
            disabled={busy}
            onChange={(event) => setShareWithCompany(event.target.checked)}
          />
          Share with {context.tetherCompany.name}
        </label>
      ) : null}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={busy || !email.trim()}>
          {busy ? "Adding…" : "Add Apple ID"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => onDone(null)}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AccountDetail({
  account,
  context,
}: {
  account: AppleAccount;
  context: AppleCompanyContext;
}) {
  const client = useAppleAccountsClient();
  const teams = useAppleCloudQuery(client, appleAccountFunctions.listTeams, {
    accountId: account.id,
  });
  const [displayName, setDisplayName] = useState(account.displayName);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [scopeError, setScopeError] = useState<string | null>(null);
  const [addingTeam, setAddingTeam] = useState(false);
  useEffect(() => setDisplayName(account.displayName), [account.displayName]);

  const update = async (next: { displayName: string; scope: AppleAccount["scope"] }) => {
    if (!client || busy) return;
    const scopeChanged = JSON.stringify(next.scope) !== JSON.stringify(account.scope);
    setBusy(true);
    setScopeError(null);
    try {
      await client.mutation(appleAccountFunctions.updateAccount, {
        accountId: account.id,
        displayName: next.displayName,
        scope: next.scope,
        expectedRevision: account.revision,
      });
    } catch (error) {
      // A scope change can conflict because projects still link this account; the server says so.
      const details = describeAppleError(error, {
        fallback: "The Apple ID was not updated.",
        ...(scopeChanged ? {} : { conflictMessage: APPLE_CONFLICT_MESSAGE }),
      });
      if (scopeChanged) setScopeError(details.message);
      else
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not update Apple ID",
            description: details.message,
          }),
        );
      setDisplayName(account.displayName);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!client || busy) return;
    setBusy(true);
    try {
      await client.mutation(appleAccountFunctions.removeAccount, {
        accountId: account.id,
        expectedRevision: account.revision,
      });
    } catch (error) {
      reportAppleError("Could not remove Apple ID", error, {
        fallback: "The Apple ID was not removed.",
        conflictMessage: APPLE_CONFLICT_MESSAGE,
      });
      setConfirmRemove(false);
    } finally {
      setBusy(false);
    }
  };
  const scopeValue = account.scope.kind === "user" ? "user" : account.scope.companyId;
  const scopeOptions = [
    { value: "user", label: "Personal" },
    ...(context.tetherCompany
      ? [{ value: context.tetherCompany.id as string, label: context.tetherCompany.name }]
      : []),
    ...(account.scope.kind === "company" && account.scope.companyId !== context.tetherCompany?.id
      ? [
          {
            value: account.scope.companyId as string,
            label: context.companyName(account.scope.companyId) ?? "Company",
          },
        ]
      : []),
  ];

  return (
    <div className="min-w-0 space-y-4 rounded-md border p-3">
      <div>
        <p className="truncate text-sm font-medium">{account.email}</p>
        <p className="text-xs text-muted-foreground">
          {account.verifiedAt === null
            ? "Not verified yet — Apple ID sign-in arrives with managed Xcode."
            : `Verified ${relativeTime(account.verifiedAt)}`}
        </p>
      </div>
      <SettingsRow
        title="Display name"
        control={
          <Input
            className="w-full sm:w-56"
            aria-label="Display name"
            value={displayName}
            maxLength={200}
            disabled={busy}
            onChange={(event) => setDisplayName(event.target.value)}
            onBlur={() => {
              const trimmed = displayName.trim();
              if (!trimmed) setDisplayName(account.displayName);
              else if (trimmed !== account.displayName)
                void update({ displayName: trimmed, scope: account.scope });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
          />
        }
      />
      <SettingsRow
        title="Shared with"
        description={
          scopeError ??
          "Personal Apple IDs are visible only to you. Sharing with a company lets its members with integration access use it. Unlink projects before changing this."
        }
        status={scopeError ? <span className="text-destructive">Not changed</span> : undefined}
        control={
          <Select
            value={scopeValue}
            disabled={busy || scopeOptions.length < 2}
            onValueChange={(value) => {
              if (value === null || value === scopeValue) return;
              void update({
                displayName: account.displayName,
                scope:
                  value === "user"
                    ? { kind: "user" }
                    : { kind: "company", companyId: value as CompanyId },
              });
            }}
          >
            <SelectTrigger aria-label="Apple ID sharing" className="w-full sm:w-56">
              <SelectValue>
                {scopeOptions.find((option) => option.value === scopeValue)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {scopeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />

      <div className="space-y-2" id="apple-teams">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-medium">Developer teams</p>
          <Button size="xs" variant="outline" onClick={() => setAddingTeam(true)}>
            <PlusIcon />
            Add team
          </Button>
        </div>
        {addingTeam ? (
          <AddTeamForm accountId={account.id} onDone={() => setAddingTeam(false)} />
        ) : null}
        {teams.error ? (
          <p role="alert" className="text-sm text-destructive">
            {describeAppleError(teams.error, { fallback: "Could not load teams." }).message}
          </p>
        ) : teams.data === undefined ? (
          <p className="text-xs text-muted-foreground">Loading teams…</p>
        ) : teams.data.length === 0 && !addingTeam ? (
          <p className="text-xs text-muted-foreground">
            Add each Developer team you use with this Apple ID. The team ID is in the Membership
            details of your Apple Developer account.
          </p>
        ) : (
          teams.data.map((team) => (
            <TeamCard key={team.teamId} team={team} companyId={context.companyId} />
          ))
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t pt-3">
        {confirmRemove ? (
          <>
            <span className="text-xs text-muted-foreground">
              Remove this Apple ID, its teams, keys and project links from every environment?
            </span>
            <Button size="xs" variant="destructive" disabled={busy} onClick={() => void remove()}>
              Remove Apple ID
            </Button>
            <Button size="xs" variant="ghost" onClick={() => setConfirmRemove(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button size="xs" variant="destructive-outline" onClick={() => setConfirmRemove(true)}>
            Remove Apple ID
          </Button>
        )}
      </div>
    </div>
  );
}

function AddTeamForm({ accountId, onDone }: { accountId: string; onDone: () => void }) {
  const client = useAppleAccountsClient();
  const [teamId, setTeamId] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<AppleTeamType>("individual");
  const [busy, setBusy] = useState(false);
  const normalized = normalizeTeamId(teamId);
  const valid = APPLE_TEAM_ID_PATTERN.test(normalized) && name.trim().length > 0;
  const save = async () => {
    if (!client || busy || !valid) return;
    setBusy(true);
    try {
      await client.mutation(appleAccountFunctions.upsertTeam, {
        accountId,
        teamId: normalized,
        name: name.trim(),
        type,
      });
      onDone();
    } catch (error) {
      reportAppleError("Could not add team", error, { fallback: "The team was not saved." });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="grid gap-3 rounded-md border p-3 sm:grid-cols-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <label className="space-y-1 text-xs">
        Team ID
        <Input
          required
          disabled={busy}
          placeholder="ABCDE12345"
          value={teamId}
          maxLength={10}
          onChange={(event) => setTeamId(event.target.value)}
        />
      </label>
      <label className="space-y-1 text-xs">
        Team name
        <Input
          required
          disabled={busy}
          value={name}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <label className="space-y-1 text-xs">
        Type
        <Select
          value={type}
          disabled={busy}
          onValueChange={(value) => {
            if (value !== null) setType(value as AppleTeamType);
          }}
        >
          <SelectTrigger aria-label="Team type">
            <SelectValue>
              {APPLE_TEAM_TYPES.find((option) => option.value === type)?.label}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {APPLE_TEAM_TYPES.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </label>
      {teamId && !APPLE_TEAM_ID_PATTERN.test(normalized) ? (
        <p className="text-xs text-destructive sm:col-span-3">
          A team ID has ten letters or digits.
        </p>
      ) : null}
      <div className="flex gap-2 sm:col-span-3">
        <Button type="submit" size="sm" disabled={busy || !valid}>
          {busy ? "Saving…" : "Add team"}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Rerenders once when the soonest lease expires, so an idle environment stops reading as connected. */
function useNowUntil(deadlines: ReadonlyArray<number | null>): number {
  const [now, setNow] = useState(() => Date.now());
  const soonest = Math.min(
    ...deadlines.filter((deadline): deadline is number => deadline !== null && deadline > now),
  );
  useEffect(() => {
    if (!Number.isFinite(soonest)) return;
    const timer = window.setTimeout(() => setNow(Date.now()), soonest - Date.now() + 50);
    return () => window.clearTimeout(timer);
  }, [soonest]);
  return now;
}

function TeamCard({ team, companyId }: { team: AppleTeam; companyId: CompanyId | null }) {
  const client = useAppleAccountsClient();
  const status = useAppleCloudQuery(client, appleAccountFunctions.status, {
    accountId: team.accountId,
    teamId: team.teamId,
  });
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const testConnection = useAtomCommand(appleEnvironment.testConnection, { reportFailure: false });
  const [keyFormOpen, setKeyFormOpen] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [busy, setBusy] = useState(false);
  const integration = status.data?.integration ?? null;
  const now = useNowUntil(status.data?.environments.map((health) => health.leaseExpiresAt) ?? []);
  const healthRows = useMemo(
    () =>
      environmentHealthRows(
        status.data?.environments ?? [],
        now,
        (environmentId) =>
          environments.find((environment) => environment.environmentId === environmentId)?.label,
      ),
    [environments, now, status.data?.environments],
  );
  const target: AppleTarget | null =
    companyId === null ? null : { companyId, accountId: team.accountId, teamId: team.teamId };
  const typeLabel = APPLE_TEAM_TYPES.find((option) => option.value === team.type)?.label;

  const revoke = async () => {
    if (!client || !integration || busy) return;
    setBusy(true);
    try {
      await client.mutation(appleAccountFunctions.revoke, {
        accountId: team.accountId,
        teamId: team.teamId,
        expectedRevision: integration.revision,
      });
    } catch (error) {
      reportAppleError("Could not revoke key", error, {
        fallback: "The API key was not revoked.",
        conflictMessage: APPLE_CONFLICT_MESSAGE,
      });
    } finally {
      setBusy(false);
      setConfirmRevoke(false);
    }
  };
  const runTest = async () => {
    if (!target || primaryEnvironmentId === null || busy) return;
    setBusy(true);
    const result = await testConnection({ environmentId: primaryEnvironmentId, input: target });
    setBusy(false);
    if (AsyncResult.isSuccess(result)) {
      const failure = result.value.health.error;
      toastManager.add(
        failure
          ? stackedThreadToast({
              type: "error",
              title: "Connection test failed",
              description: describeAppleError({ data: failure }, { fallback: failure.message })
                .message,
            })
          : { type: "success", title: "App Store Connect is reachable" },
      );
    } else {
      reportAppleError("Connection test failed", Cause.squash(result.cause), {
        fallback: "Could not test this key on this environment.",
      });
    }
  };

  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm font-medium">{team.name}</p>
        <span className="font-mono text-xs text-muted-foreground">{team.teamId}</span>
        {typeLabel ? (
          <Badge variant="outline" size="sm">
            {typeLabel}
          </Badge>
        ) : null}
      </div>
      {status.error ? (
        <p role="alert" className="text-xs text-destructive">
          {describeAppleError(status.error, { fallback: "Could not load the key status." }).message}
        </p>
      ) : integration === null ? (
        <p className="text-xs text-muted-foreground">Loading key status…</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <Badge variant={integration.connected ? "success" : "outline"} size="sm">
              {integration.connected ? "Connected" : "Not connected"}
            </Badge>
            <span>{keySummary(integration)}</span>
            {integration.issuerId ? (
              <span className="text-muted-foreground">Issuer {integration.issuerId}</span>
            ) : null}
            {integration.connected ? (
              <span className="text-muted-foreground">
                Verified {relativeTime(integration.lastVerifiedAt)}
              </span>
            ) : null}
          </div>
          {integration.connected ? <EnvironmentHealthList rows={healthRows} /> : null}
          <div className="flex flex-wrap gap-2">
            <Button size="xs" variant="outline" onClick={() => setKeyFormOpen((open) => !open)}>
              {integration.connected ? "Replace key" : "Connect key"}
            </Button>
            {integration.connected ? (
              <>
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy || target === null || primaryEnvironmentId === null}
                  onClick={() => void runTest()}
                >
                  Test connection
                </Button>
                {confirmRevoke ? (
                  <>
                    <Button
                      size="xs"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => void revoke()}
                    >
                      Revoke key
                    </Button>
                    <Button size="xs" variant="ghost" onClick={() => setConfirmRevoke(false)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <Button
                    size="xs"
                    variant="destructive-outline"
                    disabled={busy}
                    onClick={() => setConfirmRevoke(true)}
                  >
                    Revoke
                  </Button>
                )}
              </>
            ) : null}
          </div>
          {confirmRevoke ? (
            <p className="text-xs text-muted-foreground">
              Every environment stops using this key within 30 seconds. Linked projects keep their
              app, but cannot read App Store Connect until a key is connected again.
            </p>
          ) : null}
          {keyFormOpen ? (
            <KeyForm
              team={team}
              expectedRevision={integration.revision}
              onDone={() => setKeyFormOpen(false)}
            />
          ) : null}
          {integration.connected && target !== null && primaryEnvironmentId !== null ? (
            <TeamApps environmentId={primaryEnvironmentId} target={target} />
          ) : null}
        </>
      )}
    </div>
  );
}

function EnvironmentHealthList({ rows }: { rows: ReturnType<typeof environmentHealthRows> }) {
  if (rows.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No environment is using this key right now. An environment connects when it first reads App
        Store Connect.
      </p>
    );
  }
  return (
    <ul className="space-y-1 text-xs" aria-label="Environment health">
      {rows.map((row) => (
        <li key={row.environmentId} className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{row.label}</span>
          <Badge variant={row.state === "connected" ? "success" : "outline"} size="sm">
            {ENVIRONMENT_KEY_STATE_LABELS[row.state]}
          </Badge>
          {row.lastVerifiedAt !== null ? (
            <span className="text-muted-foreground">
              Last read {relativeTime(row.lastVerifiedAt)}
            </span>
          ) : null}
          {row.error ? <span className="text-destructive">{row.error}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function KeyForm({
  team,
  expectedRevision,
  onDone,
}: {
  team: AppleTeam;
  expectedRevision: number;
  onDone: () => void;
}) {
  const client = useAppleAccountsClient();
  const [draft, setDraft] = useState<KeyDraft>(EMPTY_KEY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // The private key lives only in this form's state. Drop it and the file selection on unmount.
  useEffect(
    () => () => {
      if (fileInputRef.current) fileInputRef.current.value = "";
    },
    [],
  );
  const problem = keyDraftProblem(draft);
  const save = async () => {
    if (!client || busy || problem) return;
    setBusy(true);
    setError(null);
    try {
      await client.action(appleAccountFunctions.connect, {
        accountId: team.accountId,
        teamId: team.teamId,
        issuerId: draft.issuerId.trim(),
        keyId: draft.keyId.trim(),
        privateKey: draft.privateKey,
        expectedRevision,
      });
      setDraft(EMPTY_KEY_DRAFT);
      if (fileInputRef.current) fileInputRef.current.value = "";
      toastManager.add({ type: "success", title: "App Store Connect key connected" });
      onDone();
    } catch (failure) {
      setError(
        describeAppleError(failure, {
          fallback: "The key was not connected.",
          conflictMessage: APPLE_CONFLICT_MESSAGE,
        }).message,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      id="apple-api-key"
      className="grid gap-3 rounded-md border p-3 sm:grid-cols-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <p className="text-xs text-muted-foreground sm:col-span-2">
        Create a Team key in App Store Connect under Users and Access → Integrations. Pathway checks
        it with App Store Connect, then encrypts it in your Pathway account. The current key keeps
        working if the new one is rejected.
      </p>
      <label className="space-y-1 text-xs">
        Issuer ID
        <Input
          required
          disabled={busy}
          autoComplete="off"
          value={draft.issuerId}
          onChange={(event) => setDraft({ ...draft, issuerId: event.target.value })}
        />
      </label>
      <label className="space-y-1 text-xs">
        Key ID
        <Input
          required
          disabled={busy}
          autoComplete="off"
          value={draft.keyId}
          onChange={(event) => setDraft({ ...draft, keyId: event.target.value })}
        />
      </label>
      <div className="space-y-1 text-xs sm:col-span-2">
        <span>Private key (.p8)</span>
        <input
          ref={fileInputRef}
          type="file"
          accept=".p8"
          disabled={busy}
          className="block text-xs"
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            void file.text().then((privateKey) => {
              setDraft((current) => ({
                ...current,
                privateKey,
                // Apple names downloads AuthKey_<KEYID>.p8.
                keyId: current.keyId || (/^AuthKey_([A-Z0-9]+)\.p8$/u.exec(file.name)?.[1] ?? ""),
              }));
            });
          }}
        />
        <Textarea
          aria-label="Private key"
          placeholder="Or paste the key, starting with -----BEGIN PRIVATE KEY-----"
          disabled={busy}
          spellCheck={false}
          autoComplete="off"
          className="font-mono"
          rows={4}
          value={draft.privateKey}
          onChange={(event) => setDraft({ ...draft, privateKey: event.target.value })}
        />
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive sm:col-span-2">
          {error}
        </p>
      ) : null}
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={busy || problem !== null}>
          {busy ? "Checking key…" : "Connect key"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setDraft(EMPTY_KEY_DRAFT);
            onDone();
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function TeamApps({
  environmentId,
  target,
}: {
  environmentId: EnvironmentId;
  target: AppleTarget;
}) {
  const apps = useEnvironmentQuery(appleEnvironment.listApps({ environmentId, input: target }));
  return (
    <AppList
      title="Apps"
      apps={apps.data}
      error={apps.error}
      isPending={apps.isPending}
      onRefresh={apps.refresh}
    />
  );
}

export function AppList({
  title,
  apps,
  error,
  isPending,
  onRefresh,
  renderAction,
}: {
  title: string;
  apps: ReadonlyArray<{ id: string; name: string; bundleId: string }> | null;
  error: string | null;
  isPending: boolean;
  onRefresh: () => void;
  renderAction?: (app: { id: string; name: string; bundleId: string }) => ReactNode;
}) {
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-medium">{title}</p>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label="Refresh apps"
          disabled={isPending}
          onClick={onRefresh}
        >
          <RefreshCwIcon />
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : apps === null ? (
        <p className="text-xs text-muted-foreground">Loading apps…</p>
      ) : apps.length === 0 ? (
        <p className="text-xs text-muted-foreground">This team has no apps in App Store Connect.</p>
      ) : (
        <ul className="space-y-1">
          {apps.map((app) => (
            <li key={app.id} className="flex items-center gap-2 text-xs">
              <span className="min-w-0 flex-1 truncate">
                <span className="font-medium">{app.name}</span>{" "}
                <span className="font-mono text-muted-foreground">{app.bundleId}</span>
              </span>
              {renderAction?.(app)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
