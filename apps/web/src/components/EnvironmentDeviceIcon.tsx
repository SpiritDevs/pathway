import type { ExecutionEnvironmentDeviceKind } from "@spiritdevs/contracts";
import { Code2Icon, HardDriveIcon, LaptopIcon, MonitorIcon, ServerIcon } from "lucide-react";

import type { EnvironmentPresentation } from "../state/environments";

export function inferredEnvironmentDeviceKind(
  environment: EnvironmentPresentation,
): ExecutionEnvironmentDeviceKind {
  const advertised = environment.descriptor?.device?.kind;
  if (advertised && advertised !== "unknown") return advertised;
  const candidate =
    `${environment.descriptor?.device?.model ?? ""} ${environment.label}`.toLowerCase();
  if (candidate.includes("macbook") || candidate.includes("laptop")) return "laptop";
  if (
    candidate.includes("mac studio") ||
    candidate.includes("mac mini") ||
    candidate.includes("mac pro") ||
    candidate.includes("imac") ||
    candidate.includes("desktop")
  ) {
    return "desktop";
  }
  return advertised ?? "unknown";
}

export function isDevelopmentEnvironment(environment: EnvironmentPresentation): boolean {
  return (
    environment.descriptor?.runtime?.mode === "development" ||
    (import.meta.env.DEV && environment.entry.target._tag === "PrimaryConnectionTarget")
  );
}

export function EnvironmentDeviceIcon({
  environment,
  className = "size-4",
}: {
  environment: EnvironmentPresentation;
  className?: string;
}) {
  if (isDevelopmentEnvironment(environment)) return <Code2Icon className={className} />;
  switch (inferredEnvironmentDeviceKind(environment)) {
    case "desktop":
      return <MonitorIcon className={className} />;
    case "laptop":
      return <LaptopIcon className={className} />;
    case "server":
      return <ServerIcon className={className} />;
    case "virtual":
    case "unknown":
      return <HardDriveIcon className={className} />;
  }
}
