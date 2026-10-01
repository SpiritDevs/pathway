import type { DeviceControlProof, DeviceSummary, EnvironmentId } from "@spiritdevs/contracts";
import { useEffect, useRef, useState } from "react";
import {
  captureDeviceScreenshot,
  DeviceScreenshotError,
} from "@spiritdevs/client-runtime/device/screenshot";
import { refreshDeviceHubAccess, useDeviceHubAccess } from "~/state/device";
import { DeviceControlBar } from "./DeviceControlBar";
import { DeviceControlsRail } from "./DeviceControlsRail";
import { DeviceStreamView, type DeviceStreamHandle } from "./DeviceStreamView";
import { DeviceToolsPanel } from "./DeviceToolsPanel";
import { useDeviceControlLease } from "./useDeviceControlLease";
import { useDeviceControls } from "./useDeviceControls";

/** Keyed by environment and device; the screen, quick controls and drawer share the same session. */
export function DeviceWorkspace(props: {
  environmentId: EnvironmentId;
  threadId: string;
  device: DeviceSummary;
  hostLabel: string;
  hostDiagnostics: string | undefined;
  visible: boolean;
  onFloat?: (() => void) | undefined;
  onClose: () => void;
  onPowerOff: (control: DeviceControlProof | undefined) => void;
  onOpenThread: (threadId: string) => void;
  /** Starts the thread's continuation; called only after control is released. */
  onResumeAgent?: (() => void) | undefined;
}) {
  const [handle, setHandle] = useState<DeviceStreamHandle | null>(null);
  const [toolsOpen, setToolsOpen] = useState(false);
  const [axOverlay, setAxOverlay] = useState(false);
  const [screenshotPending, setScreenshotPending] = useState(false);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const captureRef = useRef<AbortController | null>(null);
  const downloadRef = useRef<string | null>(null);
  const access = useDeviceHubAccess(props.environmentId, props.device.hostId);
  const lease = useDeviceControlLease({
    environmentId: props.environmentId,
    hostId: props.device.hostId,
    deviceId: props.device.id,
    visible: props.visible,
  });
  const controls = useDeviceControls({
    ...props,
    access,
    control: lease.control,
    onControlError: lease.reportError,
  });
  const watching = lease.control === null;
  useEffect(() => {
    if (!access || !props.visible) captureRef.current?.abort();
    return () => {
      captureRef.current?.abort();
      if (downloadRef.current) URL.revokeObjectURL(downloadRef.current);
      downloadRef.current = null;
    };
  }, [access, props.visible]);
  const saveScreenshot = () => {
    if (!access || captureRef.current || !props.visible) return;
    const controller = new AbortController();
    captureRef.current = controller;
    setScreenshotPending(true);
    setScreenshotError(null);
    return captureDeviceScreenshot(
      { access, platform: props.device.platform, deviceId: props.device.id },
      controller.signal,
    )
      .then((image) => {
        if (controller.signal.aborted) return;
        if (downloadRef.current) URL.revokeObjectURL(downloadRef.current);
        const url = URL.createObjectURL(image);
        downloadRef.current = url;
        const link = document.createElement("a");
        link.href = url;
        link.download = `${props.device.name.replace(/[^a-z0-9-]/gi, "-")}-${Date.now()}.png`;
        document.body.append(link);
        link.click();
        link.remove();
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          if (cause instanceof DeviceScreenshotError && cause.status === 401)
            refreshDeviceHubAccess(props.environmentId);
          setScreenshotError(
            cause instanceof Error ? cause.message : "Screenshot capture failed. Try again.",
          );
        }
      })
      .finally(() => {
        if (captureRef.current === controller) {
          captureRef.current = null;
          setScreenshotPending(false);
        }
      });
  };
  return (
    <>
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
        <DeviceControlBar
          lease={lease}
          threadId={props.threadId}
          onOpenThread={props.onOpenThread}
          onResumeAgent={props.onResumeAgent}
        />
        {screenshotError || (controls.error && !toolsOpen) ? (
          <p role="alert" className="px-3 py-2 text-xs text-destructive">
            {screenshotError ?? controls.error}
          </p>
        ) : null}
        <div className="min-h-0 flex-1">
          <DeviceStreamView
            environmentId={props.environmentId}
            platform={props.device.platform}
            deviceName={props.device.name}
            deviceDescription={`${props.hostLabel} · ${props.device.version}`}
            deviceId={props.device.id}
            hostId={props.device.hostId}
            visible={props.visible}
            axOverlay={axOverlay}
            control={lease.control}
            allowPhoneView
            onHandle={setHandle}
            renderControls={(view) => (
              <DeviceControlsRail
                platform={props.device.platform}
                handle={watching && handle ? { ...handle, inputConnected: false } : handle}
                view={view}
                controls={controls}
                screenshotPending={screenshotPending}
                onScreenshot={() => void saveScreenshot()}
                toolsOpen={toolsOpen}
                onTools={() => setToolsOpen(!toolsOpen)}
                onFloat={props.onFloat}
                onClose={props.onClose}
                onPowerOff={() => props.onPowerOff(lease.control ?? undefined)}
                powerOffDisabled={watching}
              />
            )}
          />
        </div>
      </div>
      {toolsOpen ? (
        <DeviceToolsPanel
          device={props.device}
          controls={controls}
          hostDiagnostics={props.hostDiagnostics}
          access={access}
          axOverlay={axOverlay}
          onAxOverlayChange={setAxOverlay}
          onClose={() => setToolsOpen(false)}
          className="absolute inset-y-0 right-0 z-10 w-full max-w-72 border-l shadow-lg @[700px]:static @[700px]:w-72 @[700px]:shrink-0 @[700px]:shadow-none"
        />
      ) : null}
    </>
  );
}
