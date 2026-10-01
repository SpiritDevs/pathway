import { DeviceHostUpdates } from "./DeviceHostUpdates";
import { DeviceToolDriftBanner } from "./DeviceToolDriftBanner";
import type {
  DeviceControlProof,
  DevicePlatform,
  DeviceServiceState,
  DeviceSummary,
  ScopedThreadRef,
} from "@spiritdevs/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Smartphone, Tablet, Tv, Watch, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { useRightPanelStore, type RightPanelSurface } from "~/rightPanelStore";
import { Button } from "~/components/ui/button";
import { DiscoveryList, DiscoveryListRow } from "~/components/ui/discovery-list";
import { Dialog } from "~/components/ui/dialog";
import { WizardPopup } from "~/components/ui/wizard";
import { Spinner } from "~/components/ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";
import { scopedThreadKey } from "@spiritdevs/client-runtime/environment";
import { deviceEnvironment, useDeviceState, useDeviceWorkspaceTarget } from "~/state/device";
import { useThreadShell } from "~/state/entities";
import { useSimBuildRequestStore } from "~/state/simBuild";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";
import { scopeThreadRef } from "@spiritdevs/client-runtime/environment";
import { ThreadId } from "@spiritdevs/contracts";
import { buildThreadRouteParams } from "~/threadRoutes";
import { deviceControlErrorCode, deviceControlErrorCopy } from "./deviceControl";
import { DeviceLoadingView } from "./DeviceLoadingView";
import { DeviceSetup } from "./DeviceSetup";
import { DeviceWorkspace } from "./DeviceWorkspace";
import { SimBuildBar } from "./SimBuildBar";
import { shouldOfferXcodeSetup } from "./deviceXcodeSetup.logic";
import { useXcodeHost, XcodeSetupFlow } from "../xcode/XcodeSetup";
import { DeviceWatchPairing } from "./DeviceWatchPairing";
import { groupDevicesByFamily, watchPairLabel, type DeviceGroupKey } from "./deviceFamily";
import { PreviewPanelShell, type PreviewPanelMode } from "../preview/PreviewPanelShell";

const GROUP_ICONS: Record<DeviceGroupKey, typeof Smartphone> = {
  phone: Smartphone,
  pad: Tablet,
  watch: Watch,
  tv: Tv,
  ios: Smartphone,
  android: Smartphone,
};

const deviceKey = (device: Pick<DeviceSummary, "hostId" | "id">) =>
  `${device.hostId}\u0000${device.id}`;

const subscribePageVisibility = (onChange: () => void) => {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
};
const isPageVisible = () => document.visibilityState === "visible";

/** Each surface owns one host/device; only the visible surface streams. */
export function DevicePanel(props: {
  readonly mode: PreviewPanelMode;
  readonly threadRef: ScopedThreadRef;
  readonly surface: Extract<RightPanelSurface, { kind: "device" }>;
  readonly visible: boolean;
  readonly onDismissSetup: () => void;
  /** Sends the thread's continuation after this viewer hands control back. */
  readonly onResumeAgent?: (() => void) | undefined;
}) {
  const { environmentId, threadId } = props.threadRef;
  // A background tab or minimized window stops decoding video; the device keeps running.
  const pageVisible = useSyncExternalStore(subscribePageVisibility, isPageVisible, () => true);
  const { state, loaded, error: stateError, refresh } = useDeviceState(environmentId);
  const list = useAtomCommand(deviceEnvironment.list, { reportFailure: false });
  const open = useAtomCommand(deviceEnvironment.open);
  const close = useAtomCommand(deviceEnvironment.close, { reportFailure: false });
  const navigate = useNavigate();
  const [operationError, setOperationError] = useState<string | null>(null);
  const [pendingDevice, setPendingDevice] = useState<DeviceSummary | null>(null);
  const pendingDeviceKey = pendingDevice ? deviceKey(pendingDevice) : null;

  const hostDisabled = state.hostStatus === "disabled";

  // Opening setup never grants permission to install or start helpers.
  useEffect(() => {
    if (!props.visible || !loaded || hostDisabled) return;
    void list({ environmentId, input: {} });
  }, [environmentId, list, loaded, props.visible, hostDisabled]);

  // Selected apart from the whole state, so the stream subtree skips unrelated publications.
  const workspace = useDeviceWorkspaceTarget(environmentId, threadId, props.surface.target);
  const activeSession = workspace?.session;
  const activeDevice = workspace?.device;

  const grouped = useMemo(() => groupDevicesByFamily(state.devices), [state.devices]);

  const selectDevice = async (value: string) => {
    const device = state.devices.find((candidate) => deviceKey(candidate) === value);
    if (!device) return;
    setOperationError(null);
    setPendingDevice(device);
    try {
      const result = await open({
        environmentId,
        input: {
          threadId,
          hostId: device.hostId,
          deviceId: device.id,
          platform: device.platform,
        },
      });
      if (result._tag === "Failure") setOperationError(formatEnvironmentQueryError(result.cause));
      else
        useRightPanelStore.getState().openDevice(props.threadRef, {
          hostId: result.value.hostId,
          deviceId: result.value.deviceId,
          platform: device.platform,
          name: device.name,
        });
    } finally {
      setPendingDevice(null);
    }
  };

  // Closing the view leaves the simulator running; power-off is explicit.
  const { threadRef, surface } = props;
  const closeActive = useCallback(
    (powerOff: boolean, control?: DeviceControlProof) => {
      if (!powerOff) {
        useRightPanelStore.getState().closeSurface(threadRef, surface.id);
        return;
      }
      if (!activeSession) return;
      setOperationError(null);
      void close({
        environmentId,
        input: {
          threadId,
          hostId: activeSession.hostId,
          deviceId: activeSession.deviceId,
          shutdown: powerOff,
          ...(control ? { control } : {}),
        },
      }).then((result) => {
        if (result._tag === "Failure") {
          const code = deviceControlErrorCode(result.cause);
          if (code === "stale_generation") refresh();
          setOperationError(
            code ? deviceControlErrorCopy[code] : formatEnvironmentQueryError(result.cause),
          );
        } else useRightPanelStore.getState().closeSurface(threadRef, surface.id);
      });
    },
    [activeSession, close, environmentId, refresh, surface.id, threadId, threadRef],
  );
  const onClose = useCallback(() => closeActive(false), [closeActive]);
  const onPowerOff = useCallback(
    (control: DeviceControlProof | undefined) => closeActive(true, control),
    [closeActive],
  );
  const onOpenThread = useCallback(
    (ownerThreadId: string) =>
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(environmentId, ThreadId.make(ownerThreadId))),
      }),
    [environmentId, navigate],
  );

  const bootingDevices =
    state.bootingDevices?.filter((device) => device.threadId === threadId) ?? [];
  const hostReady = Object.values(state.hostStatuses).some((host) => host.status === "ready");
  const hostBusy =
    !hostReady &&
    Object.values(state.hostStatuses).some(
      (host) => host.status === "installing" || host.status === "starting",
    );
  const xcodeHost = useXcodeHost(environmentId);
  // Setup sits above the list so Android devices stay reachable while Xcode installs.
  const offerXcode = loaded && !hostBusy && shouldOfferXcodeSetup(state, xcodeHost.support);
  const projectId = useThreadShell(props.threadRef)?.projectId ?? null;
  // A palette "Run on simulator" request opens the run form once an iOS simulator is showing.
  const threadKey = scopedThreadKey(props.threadRef);
  const runRequested = useSimBuildRequestStore((store) => store.requestedThreadKeys.has(threadKey));
  const [runFormRequest, setRunFormRequest] = useState(0);
  const runTarget = props.visible && activeDevice?.platform === "ios";
  useEffect(() => {
    if (runRequested && runTarget && useSimBuildRequestStore.getState().take(threadKey))
      setRunFormRequest((count) => count + 1);
  }, [runRequested, runTarget, threadKey]);
  const unavailablePlatforms = state.hosts.flatMap((host) =>
    host.platforms
      .filter((platform) => !platform.available)
      .map((platform) => ({ ...platform, hostId: host.id, hostLabel: host.label })),
  );

  if (loaded && (!state.onboardingCompleted || hostDisabled)) {
    return (
      <Dialog
        open={props.visible}
        onOpenChange={(isOpen) => {
          if (!isOpen) props.onDismissSetup();
        }}
      >
        <WizardPopup>
          <DeviceSetup environmentId={environmentId} state={state} />
        </WizardPopup>
      </Dialog>
    );
  }

  return (
    <PreviewPanelShell mode={props.mode}>
      {stateError ? (
        <div role="alert" className="border-b p-3 text-sm text-destructive">
          {stateError}
          <Button size="sm" variant="outline" onClick={refresh}>
            Retry
          </Button>
        </div>
      ) : null}
      {hostReady && !activeDevice && state.hostStatusDetail ? (
        <div
          role="status"
          className="whitespace-pre-line border-b px-3 py-2 text-xs text-muted-foreground"
        >
          {state.hostStatusDetail}
        </div>
      ) : null}
      <DeviceHostUpdates state={state} environmentId={environmentId} />
      <DeviceToolDriftBanner state={state} environmentId={environmentId} />
      {bootingDevices.length > 0 ? (
        <div role="status" className="border-b px-3 py-2 text-xs text-muted-foreground">
          Starting {bootingDevices.map((device) => device.name).join(", ")}… This can take a minute.
        </div>
      ) : null}
      {operationError ? (
        <div
          role="alert"
          className="flex items-start gap-2 border-b bg-destructive/5 px-3 py-2 text-xs text-destructive"
        >
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{operationError}</p>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss device error"
            onClick={() => setOperationError(null)}
          >
            <X className="size-3" />
          </Button>
        </div>
      ) : null}
      {runRequested && !activeDevice ? (
        <div
          role="status"
          className="flex items-center gap-2 border-b px-3 py-2 text-xs text-muted-foreground"
        >
          <p className="flex-1">Choose an iOS simulator to run this thread's app on.</p>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Dismiss run request"
            onClick={() => useSimBuildRequestStore.getState().take(threadKey)}
          >
            <X className="size-3" />
          </Button>
        </div>
      ) : null}
      <div className="@container relative flex min-h-0 flex-1">
        {workspace && activeDevice ? (
          <DeviceWorkspace
            key={`${environmentId}\u0000${deviceKey(activeDevice)}`}
            environmentId={environmentId}
            threadId={threadId}
            device={activeDevice}
            hostLabel={workspace.hostLabel}
            hostDiagnostics={state.hostStatusDetail}
            devices={workspace.devices}
            visible={props.visible && pageVisible}
            onClose={onClose}
            onPowerOff={onPowerOff}
            onOpenThread={onOpenThread}
            onResumeAgent={props.onResumeAgent}
          />
        ) : pendingDevice || hostBusy || (!loaded && !stateError) ? (
          <DeviceLoadingView
            name={pendingDevice?.name ?? "Devices"}
            description={
              pendingDevice
                ? `${state.hosts.find((host) => host.id === pendingDevice.hostId)?.label ?? "Device host"} · ${pendingDevice.version}`
                : ""
            }
            stage="opening"
            message={
              pendingDevice
                ? pendingDevice.booted
                  ? "Opening device…"
                  : "Starting device…"
                : state.hostStatus === "installing"
                  ? (state.hostStatusDetail ?? "Installing device support…")
                  : "Finding devices…"
            }
          />
        ) : (
          <div className="flex size-full flex-col overflow-y-auto px-5 py-8 text-sm text-muted-foreground">
            {offerXcode ? (
              <div className="mb-6 text-foreground">
                <XcodeSetupFlow
                  environmentId={environmentId}
                  visible={props.visible && pageVisible}
                  // Re-inventory once Xcode is usable; simulators then replace this setup.
                  onReady={() => void list({ environmentId, input: {} })}
                />
              </div>
            ) : null}
            <div
              className={cn(
                "mx-auto flex w-full max-w-xl flex-col gap-6",
                grouped.length === 0 && "my-auto items-center text-center",
              )}
            >
              {grouped.length === 0 && !offerXcode ? (
                <>
                  <Smartphone className="size-6 opacity-60" />
                  <p className="max-w-sm">
                    {state.hostStatus === "failed"
                      ? (state.hostStatusDetail ?? "The device hub failed to start.")
                      : "No simulators or emulators were found on this environment."}
                  </p>
                </>
              ) : null}
              {hostReady && grouped.length > 0 ? (
                <div className="w-full space-y-6 text-left">
                  {grouped.map((group) => {
                    const Icon = GROUP_ICONS[group.key];
                    return (
                      <section key={group.key} className="space-y-3">
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Icon className="size-4 shrink-0" />
                          <h3 className="font-medium">{group.label}</h3>
                        </div>
                        <DiscoveryList>
                          {group.devices.map((device) => {
                            // Another environment's lease blocks opening and booting here.
                            const owner =
                              device.inUseBy && device.inUseBy.environmentId !== environmentId
                                ? device.inUseBy.environmentLabel
                                : null;
                            const row = (
                              <DiscoveryListRow
                                key={deviceKey(device)}
                                icon={
                                  <span className="grid size-8 shrink-0 place-items-center rounded-md border border-border/60">
                                    <Icon className="size-4" />
                                  </span>
                                }
                                title={device.name}
                                description={[
                                  state.hosts.find((host) => host.id === device.hostId)?.label,
                                  device.version,
                                  owner
                                    ? `In use by ${owner}`
                                    : device.booted
                                      ? "Running"
                                      : "Stopped",
                                  // Pairing controls follow an available Watch row instead.
                                  owner ? watchPairLabel(device, state.devices) : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                                disabled={pendingDeviceKey !== null || owner !== null}
                                aria-label={
                                  owner
                                    ? `${device.name}, in use by ${owner}`
                                    : `${device.booted ? "Open" : "Start"} ${device.name}`
                                }
                                onClick={() => void selectDevice(deviceKey(device))}
                                action={
                                  pendingDeviceKey === deviceKey(device) ? (
                                    <Spinner className="size-3" />
                                  ) : (
                                    <span className="text-xs text-muted-foreground">
                                      {owner ? "In use" : device.booted ? "Open" : "Start"}
                                    </span>
                                  )
                                }
                              />
                            );
                            if (!owner && device.family === "watch")
                              return (
                                <div key={deviceKey(device)}>
                                  {row}
                                  <div className="px-3 pb-2.5 pl-14">
                                    <DeviceWatchPairing
                                      environmentId={environmentId}
                                      watch={device}
                                      devices={state.devices}
                                      disabled={pendingDeviceKey !== null}
                                    />
                                  </div>
                                </div>
                              );
                            if (!owner) return row;
                            // The disabled row ignores pointer events and focus, so the wrapper owns the tooltip.
                            return (
                              <Tooltip key={deviceKey(device)}>
                                <TooltipTrigger
                                  render={
                                    <div
                                      tabIndex={0}
                                      className="rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
                                    />
                                  }
                                >
                                  {row}
                                </TooltipTrigger>
                                <TooltipPopup>
                                  {owner} is using this device. It becomes available when that
                                  environment turns off device support or stops.
                                </TooltipPopup>
                              </Tooltip>
                            );
                          })}
                        </DiscoveryList>
                      </section>
                    );
                  })}
                </div>
              ) : null}
              {hostReady &&
              !state.devices.some((device) => device.platform === "android") &&
              !unavailablePlatforms.some((platform) => platform.platform === "android") ? (
                <p className="max-w-sm text-xs">
                  No Android virtual devices found. Create one in Android Studio's Device Manager,
                  then refresh.
                </p>
              ) : null}
              {loaded && !hostBusy ? (
                <Button
                  className={grouped.length > 0 ? "self-start" : "self-center"}
                  variant={grouped.length > 0 ? "ghost" : "outline"}
                  size="sm"
                  onClick={() => void list({ environmentId, input: {} })}
                >
                  Refresh devices
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </div>
      {activeDevice && activeSession ? (
        <SimBuildBar
          environmentId={environmentId}
          threadId={threadId}
          projectId={projectId}
          device={activeDevice}
          hostSupport={xcodeHost.support}
          visible={props.visible && pageVisible}
          openRequest={runFormRequest}
        />
      ) : null}
    </PreviewPanelShell>
  );
}
