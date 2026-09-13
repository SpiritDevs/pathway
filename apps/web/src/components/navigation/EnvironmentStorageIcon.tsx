import { useAuth } from "@clerk/react";
import type { EnvironmentId } from "@spiritdevs/contracts";
import { HardDriveIcon } from "lucide-react";
import { useStoragePressure } from "../../hooks/useStoragePressure";

export function EnvironmentStorageIcon({ environmentId }: { environmentId: EnvironmentId }) {
  const { userId } = useAuth({ treatPendingAsSignedOut: false });
  const readings = useStoragePressure(userId ?? null, false);
  const reading = readings.find((entry) => entry.environment.environmentId === environmentId);
  const pressure = reading?.pressure === "unknown" ? reading.last?.pressure : reading?.pressure;
  if (pressure !== "warning" && pressure !== "critical") return null;
  const label = `${pressure === "critical" ? "Critical storage" : "Low storage"}${reading?.pressure === "unknown" ? " (last known)" : ""}`;
  return (
    <span className="ml-auto inline-flex shrink-0" title={label}>
      <HardDriveIcon
        role="img"
        aria-label={label}
        className={`size-3.5 ${pressure === "critical" ? "text-destructive" : "text-warning"}`}
      />
    </span>
  );
}
