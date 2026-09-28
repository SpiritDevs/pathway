import type { EnvironmentId } from "@spiritdevs/contracts";
import { squashAtomCommandFailure } from "@spiritdevs/client-runtime/state/runtime";
import { isXcodeJobActive } from "@spiritdevs/client-runtime/state/xcodeSetup";
import { useState } from "react";

import { appleEnvironment } from "~/state/apple";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  AppleIdSignIn,
  XcodeAccountPicker,
  XcodeInstallChooser,
  XcodeInstalledList,
  XcodeJobCard,
  XcodeRuntimes,
  useXcodeAccount,
  useXcodeHost,
  useXcodeLive,
  XcodeJobAnnouncer,
  type AppleIdSessionView,
  type XcodeTarget,
} from "../xcode/XcodeSetup";
import { describeXcodeFailure } from "../xcode/XcodeSetup.logic";
import { AppleEnvironmentPicker, useAppleEnvironmentSelection } from "./AppleAccountsSettings";
import { CompanySettingsEmptyState } from "./company/CompanySettingsShared";
import { useCompanySettings } from "./company/useCompanySettings";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

/** Settings → Xcode: installs, selection, platforms and the Apple ID session on one environment's Mac. */
export function XcodeSettings() {
  const settings = useCompanySettings();
  const environment = useAppleEnvironmentSelection();
  if (settings.isAuthLoaded && !settings.isSignedIn) {
    return (
      <SettingsPageContainer>
        <CompanySettingsEmptyState
          title="Sign in to manage Xcode"
          description="Xcode downloads use an Apple ID stored in your Pathway account."
        />
      </SettingsPageContainer>
    );
  }
  return (
    <SettingsPageContainer>
      <SettingsSection title="Xcode" id="xcode">
        <div className="space-y-3 px-4 py-3">
          <p className="text-sm text-muted-foreground">
            Xcode installs on the Mac that runs the environment, not on this device. Installs keep
            running when you close Pathway.
          </p>
          <AppleEnvironmentPicker
            selection={environment}
            label="Manage Xcode on"
            emptyMessage="Connect to an environment running on a Mac to manage Xcode."
          />
        </div>
      </SettingsSection>
      {environment.environmentId ? (
        <XcodeEnvironmentSettings
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

function XcodeEnvironmentSettings({ environmentId }: { environmentId: EnvironmentId }) {
  const host = useXcodeHost(environmentId);
  const account = useXcodeAccount(environmentId);
  const hostName = host.mac ?? host.label;
  const { session, view } = useXcodeLive(environmentId, account.target, host.support === "mac");
  const status = view.data?.status ?? null;
  const job = view.data?.job ?? null;
  const busy = isXcodeJobActive(job);
  const email = account.account?.email ?? "your Apple ID";

  if (host.support === "not-mac" || status?.host === "needs-mac") {
    return (
      <SettingsSection title="This environment">
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Xcode needs a Mac. {host.label} is not a Mac, so choose an environment running on a Mac.
        </p>
      </SettingsSection>
    );
  }

  const target = account.target;
  return (
    <>
      <XcodeJobAnnouncer job={job} status={status} />
      <SettingsSection title="Apple ID" id="xcode-apple-id">
        <div className="space-y-3 px-4 py-3">
          <p className="text-xs text-muted-foreground">
            {hostName}
            {host.mac ? ` · ${host.label}` : ""} downloads Xcode with this Apple ID.
          </p>
          <XcodeAccountPicker selection={account} />
          {target ? (
            <AppleIdSessionControls
              environmentId={environmentId}
              target={target}
              email={email}
              session={session}
              hostName={hostName}
            />
          ) : null}
        </div>
      </SettingsSection>
      {target ? (
        view.error ? (
          <SettingsSection title="Installed Xcodes">
            <div className="space-y-2 px-4 py-3">
              <p role="alert" className="text-sm text-destructive">
                {view.error}
              </p>
              <Button size="sm" variant="outline" onClick={view.refresh}>
                Try again
              </Button>
            </div>
          </SettingsSection>
        ) : status === null ? (
          <SettingsSection title="Installed Xcodes">
            <p className="px-4 py-3 text-sm text-muted-foreground">Checking Xcode on {hostName}…</p>
          </SettingsSection>
        ) : (
          <>
            {job && job.state !== "completed" ? (
              <SettingsSection title="Current job" id="xcode-job">
                <div className="px-4 py-3">
                  <XcodeJobCard
                    environmentId={environmentId}
                    target={target}
                    job={job}
                    status={status}
                    session={session}
                    email={email}
                    hostName={hostName}
                  />
                </div>
              </SettingsSection>
            ) : null}
            <SettingsSection title="Installed Xcodes" id="xcode-installed">
              <div className="px-4 py-3">
                <XcodeInstalledList
                  environmentId={environmentId}
                  target={target}
                  status={status}
                  busy={busy}
                />
              </div>
            </SettingsSection>
            <SettingsSection title="Platforms" id="xcode-platforms">
              <div className="px-4 py-3">
                <XcodeRuntimes
                  environmentId={environmentId}
                  target={target}
                  status={status}
                  busy={busy}
                />
              </div>
            </SettingsSection>
            <SettingsSection title="Install Xcode" id="xcode-install">
              <div className="px-4 py-3">
                {busy ? (
                  <p className="text-sm text-muted-foreground">
                    Finish or cancel the current job to install another version.
                  </p>
                ) : session.data?.state === "authenticated" ? (
                  <XcodeInstallChooser
                    environmentId={environmentId}
                    target={target}
                    status={status}
                  />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    Sign in to your Apple ID above to download Xcode.
                  </p>
                )}
              </div>
            </SettingsSection>
          </>
        )
      ) : null}
    </>
  );
}

function AppleIdSessionControls({
  environmentId,
  target,
  email,
  session,
  hostName,
}: {
  environmentId: EnvironmentId;
  target: XcodeTarget;
  email: string;
  session: AppleIdSessionView;
  hostName: string;
}) {
  const signOut = useAtomCommand(appleEnvironment.idSignOut, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <AppleIdSignIn
        environmentId={environmentId}
        target={target}
        email={email}
        session={session}
        hostName={hostName}
      />
      {session.data?.state === "authenticated" && !session.error ? (
        <div className="flex flex-wrap items-center gap-2">
          <p className="text-xs text-muted-foreground">
            Pathway keeps this Apple session sealed in your account so {hostName} can resume
            downloads. Sign out to end it.
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={async () => {
              setPending(true);
              setError(null);
              const result = await signOut({ environmentId, input: target });
              if (result._tag === "Failure") {
                setError(
                  describeXcodeFailure(squashAtomCommandFailure(result), "Could not sign out."),
                );
              }
              setPending(false);
            }}
          >
            {pending ? "Signing out…" : "Sign out"}
          </Button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
