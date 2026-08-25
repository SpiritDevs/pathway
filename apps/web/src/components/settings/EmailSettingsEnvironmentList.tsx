import { connectionStatusText } from "@spiritdevs/client-runtime/connection";
import { Link } from "@tanstack/react-router";
import { ArrowRightIcon, CloudIcon, LaptopIcon, MonitorIcon, TerminalIcon } from "lucide-react";

import { isDesktopLocalConnectionTarget } from "../../connection/desktopLocal";
import { cn } from "../../lib/utils";
import { type EnvironmentPresentation, useEnvironments } from "../../state/environments";
import {
  ConnectionStatusDot,
  connectionPhaseDotClassName,
  connectionPhasePingClassName,
} from "../ConnectionStatusDot";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

function environmentIcon(environment: EnvironmentPresentation) {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return MonitorIcon;
  if (environment.entry.target._tag === "SshConnectionTarget") return TerminalIcon;
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return LaptopIcon;
  return CloudIcon;
}

function environmentDetail(environment: EnvironmentPresentation): string {
  if (environment.entry.target._tag === "PrimaryConnectionTarget") return "Primary device";
  if (environment.relayManaged) return "Pathway Connect";
  if (environment.entry.target._tag === "SshConnectionTarget") return "SSH";
  if (isDesktopLocalConnectionTarget(environment.entry.target)) return "Local device";
  return environment.displayUrl ?? "Remote device";
}

export function EmailSettingsEnvironmentList() {
  const { environments, isReady } = useEnvironments();

  return (
    <SettingsPageContainer className="max-w-3xl">
      <SettingsSection title="Environments">
        {environments.length === 0 ? (
          <p className="rounded-xl px-3 py-6 text-center text-xs text-muted-foreground sm:px-4">
            {isReady
              ? "Connect an environment before configuring email capture."
              : "Loading environments."}
          </p>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border/60">
            {environments.map((environment) => {
              const Icon = environmentIcon(environment);
              const status = connectionStatusText(environment.connection);
              return (
                <Link
                  className={cn(
                    "group flex min-w-0 items-center gap-3 border-b border-border/50 px-3 py-3 text-left transition-colors last:border-b-0 sm:px-4",
                    "hover:bg-muted/40 focus-visible:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                  )}
                  key={environment.environmentId}
                  params={{ environmentId: environment.environmentId }}
                  to="/settings/email/$environmentId"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-background text-muted-foreground">
                    <Icon aria-hidden className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <ConnectionStatusDot
                        dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
                        pingClassName={connectionPhasePingClassName(environment.connection.phase)}
                        tooltipText={status}
                      />
                      <span className="truncate text-sm font-medium text-foreground">
                        {environment.label}
                      </span>
                    </span>
                    <span className="block truncate pl-[18px] text-xs text-muted-foreground">
                      {environmentDetail(environment)} · {status}
                    </span>
                  </span>
                  <ArrowRightIcon
                    aria-hidden
                    className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground"
                  />
                </Link>
              );
            })}
          </div>
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
