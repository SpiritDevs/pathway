import type { DesktopPendingSnapShot } from "@spiritdevs/contracts";
import { useCallback, useEffect, useState } from "react";

import { useSnapShotAccountId } from "../../lib/snapShotAccount";
import { getDesktopSnapShotBridge } from "../../lib/desktopSnapShot";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Editor actions keep the native original until the user finishes or discards it. */
export function SnapShotPendingCaptures() {
  const accountId = useSnapShotAccountId();
  const bridge = getDesktopSnapShotBridge();
  const [pending, setPending] = useState<ReadonlyArray<DesktopPendingSnapShot>>([]);
  const [discarding, setDiscarding] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (bridge) setPending(await bridge.listPendingSnapShots());
  }, [bridge]);

  useEffect(() => {
    if (!accountId) {
      setPending([]);
      return;
    }
    let mounted = true;
    const update = () => {
      void bridge
        ?.listPendingSnapShots()
        .then((captures) => {
          if (mounted) setPending(captures);
        })
        .catch(() => undefined);
    };
    update();
    const unsubscribe = bridge?.onSnapShotEvent(update);
    window.addEventListener("focus", update);
    return () => {
      mounted = false;
      unsubscribe?.();
      window.removeEventListener("focus", update);
    };
  }, [accountId, bridge]);

  const discard = async (id: string) => {
    if (!bridge || discarding) return;
    setDiscarding(id);
    try {
      await bridge.acknowledgeSnapShot(id);
      setPending((captures) => captures.filter((capture) => capture.id !== id));
      await refresh();
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Couldn't discard the saved capture",
        description: error instanceof Error ? error.message : "Try again.",
      });
    } finally {
      setDiscarding(null);
    }
  };

  if (!accountId || pending.length === 0) return null;
  return (
    <SettingsSection title="Saved captures">
      <p className="px-3 py-2 text-xs text-muted-foreground">
        Captures waiting to be edited or saved. Discarding a saved capture keeps any copy already
        attached to a draft.
      </p>
      {pending.map((capture) => (
        <SettingsRow
          key={capture.id}
          title={capture.source.appName}
          description={capture.source.windowTitle || capture.name}
          control={
            <Button
              aria-label={`Discard capture from ${capture.source.appName}`}
              disabled={discarding !== null}
              onClick={() => void discard(capture.id)}
              size="xs"
              variant="outline"
            >
              {discarding === capture.id ? "Discarding…" : "Discard"}
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );
}
