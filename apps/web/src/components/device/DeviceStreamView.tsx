import {
  DEVICE_TV_KEYBOARD_MAP,
  type DeviceControlProof,
  type DeviceFamily,
  type DevicePlatform,
  type DeviceRemoteButton,
  type EnvironmentId,
} from "@spiritdevs/contracts";
import { withDeviceControl } from "@spiritdevs/client-runtime/device/hub-access";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "~/components/ui/button";
import {
  refreshDeviceHubAccess,
  useDeviceHubAccess,
  useDeviceHubAccessError,
} from "~/state/device";
import { createCanvasFrameSink } from "@spiritdevs/client-runtime/device/frame";
import { resolveDeviceShape } from "@spiritdevs/client-runtime/device/shape-profile";
import { deviceKeyboard, deviceModel } from "./deviceModels";
import { fitDeviceFrame } from "./deviceFrameLayout";
import { crownDeltaFromWheel, familyNoun } from "./deviceFamily";
import { DeviceDuoViewport } from "./DeviceDuoViewport";
import { DeviceDuoControls } from "./DeviceDuoControls";
import { DeviceAndroidFoldControls } from "./DeviceAndroidFoldControls";
import type { DeviceControlCode } from "./deviceControl";
import type { DuoControlState } from "@spiritdevs/client-runtime/device/duo-control";
import { DevicePhoneViewport } from "./DevicePhoneViewport";
import { DeviceLoadingView } from "./DeviceLoadingView";
import { type DeviceAxElement, fetchDeviceAxTree } from "./deviceHubApi";
import {
  createDeviceStreamClient,
  type DeviceHardwareButton,
  type DeviceScreenSize,
  type DeviceStreamClient,
  type DeviceStreamStatus,
} from "@spiritdevs/client-runtime/device/stream";

const AX_POLL_INTERVAL_MS = 2_000;
const CONTROLS_RAIL_WIDTH = 56;
const AUTH_RETRY_WINDOW_MS = 15_000;
// Room for the drawn Watch/TV bezel inside the fitted box.
const BEZEL_INSET = 24;

export interface DeviceViewControls {
  readonly phone: boolean;
  readonly streaming: boolean;
  readonly phoneUnavailableReason: string | null;
  readonly showPhone: () => void;
  readonly showFlat: () => void;
  readonly resetView: () => void;
  readonly foldingControls?: ReactNode;
  readonly keyboard: {
    readonly attached: boolean;
    readonly disabled: boolean;
    readonly toggle: () => void;
  } | null;
}

export interface DeviceStreamHandle {
  readonly pressButton: (button: DeviceHardwareButton) => void;
  readonly rotate: () => void;
  /** False while the input socket is down; controls should disable. */
  readonly inputConnected: boolean;
}

/**
 * The live device screen. Pointer events map onto normalized coordinates in
 * the displayed frame and go to the device; keyboard input is forwarded while
 * the surface is focused. `visible=false` tears the stream down so a hidden
 * panel decodes nothing.
 */
export function DeviceStreamView(props: {
  readonly environmentId: EnvironmentId;
  readonly platform: DevicePlatform;
  readonly deviceId: string;
  readonly deviceName?: string;
  readonly deviceDescription?: string;
  readonly visible: boolean;
  readonly hostId: string;
  /** Watch and TV get a drawn bezel in place of the 3D phone; absent for phones and older servers. */
  readonly family?: DeviceFamily | null;
  /** Server framing hint (width / height) until the stream reports its size. */
  readonly aspectHint?: number | undefined;
  /** TV: focus-engine presses from mapped keys, set only while input is available. */
  readonly onRemoteButton?: ((button: DeviceRemoteButton) => void) | undefined;
  /** Watch: Digital Crown wheel pixels from the wheel over the screen. */
  readonly onCrown?: ((delta: number) => void) | undefined;
  /** The full panel opts into the phone spike; compact viewers retain their flat presentation. */
  readonly allowPhoneView?: boolean;
  readonly renderControls?: (view: DeviceViewControls) => ReactNode;
  /** Draw accessibility element frames over the screen. */
  readonly axOverlay?: boolean;
  readonly onHandle?: (handle: DeviceStreamHandle | null) => void;
  readonly onScreen?: (screen: DeviceScreenSize | null) => void;
  /**
   * The environment control proof. Undefined keeps unfenced input for environments without
   * leases; null is watch-only, where media keeps streaming and input is never sent.
   */
  readonly control?: DeviceControlProof | null | undefined;
  /** Control refusals from hub HTTP mutations, with the generation they were sent under. */
  readonly onControlError?: ((code: DeviceControlCode, generation: number) => void) | undefined;
}) {
  const [duoControl, setDuoControl] = useState<DuoControlState>({
    pending: false,
    requested: null,
    error: null,
  });
  const [presentation, setPresentation] = useState<"phone" | "flat">("phone");
  const [keyboardAttached, setKeyboardAttached] = useState(false);
  const [phoneUnavailable, setPhoneUnavailable] = useState(false);
  const onPhoneUnavailable = useCallback(() => setPhoneUnavailable(true), []);
  const cancelPhoneInputRef = useRef<(() => void) | null>(null);
  const cancelPhoneInput = useCallback(() => cancelPhoneInputRef.current?.(), []);
  const resetViewRef = useRef<(() => void) | null>(null);
  const onResetReady = useCallback((reset: (() => void) | null) => {
    resetViewRef.current = reset;
  }, []);
  const frameListenerRef = useRef<(() => void) | null>(null);
  const onFrameListener = useCallback((listener: (() => void) | null) => {
    frameListenerRef.current = listener;
  }, []);
  const onInputCancel = useCallback((cancel: (() => void) | null) => {
    cancelPhoneInputRef.current = cancel;
  }, []);
  const hubAccess = useDeviceHubAccess(props.environmentId, props.hostId);
  const accessError = useDeviceHubAccessError(props.environmentId);
  const inputEnabled = props.control !== null;
  const inputEnabledRef = useRef(inputEnabled);
  inputEnabledRef.current = inputEnabled;
  const controlViewer = props.control?.viewerId;
  const controlGeneration = props.control?.generation;
  const access = useMemo(
    () =>
      hubAccess && controlViewer !== undefined && controlGeneration !== undefined
        ? withDeviceControl(hubAccess, { viewerId: controlViewer, generation: controlGeneration })
        : hubAccess,
    [controlGeneration, controlViewer, hubAccess],
  );
  // Input sockets carry the control generation from their URL, so each acquisition reconnects.
  // Releasing does not: the socket stays a watcher and later reconnects omit the proof.
  const proofKeyRef = useRef<string | null>(null);
  if (controlViewer !== undefined && controlGeneration !== undefined)
    proofKeyRef.current = `${controlViewer}\n${controlGeneration}`;
  // The client reads the newest access on every (re)connect, so rotating a
  // ticket does not restart a healthy stream; only a new hub, host or control generation does.
  const accessRef = useRef(access);
  accessRef.current = access;
  const accessKey = access
    ? `${access.httpBase}\n${access.query.hostId ?? ""}\n${access.credentials}\n${proofKeyRef.current ?? ""}`
    : null;
  // Set when the hub rejected the credential; the stream restarts once access changes.
  const rejectedRef = useRef<{ readonly expiresAt: number | null } | null>(null);
  const authRestartAtRef = useRef(0);
  const [authEpoch, setAuthEpoch] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const clientRef = useRef<DeviceStreamClient | null>(null);
  const [status, setStatus] = useState<DeviceStreamStatus>("connecting");
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [showRestartNotice, setShowRestartNotice] = useState(false);
  const [screen, setScreen] = useState<DeviceScreenSize | null>(null);
  const model = deviceModel(
    props.platform,
    props.deviceName ?? "",
    screen?.supportsHingeAngle === true,
  );
  const isDuo = model?.id === "iphone-duo";
  const [foldAngle, setFoldAngle] = useState<number | null>(null);
  const [mjpegUrl, setMjpegUrl] = useState<string | null>(null);
  const [mjpegGeneration, setMjpegGeneration] = useState(0);
  const attachMjpegImage = useCallback((image: HTMLImageElement | null) => {
    clientRef.current?.setMjpegImage(image);
  }, []);
  const [inputState, setInputState] = useState<{ connected: boolean; detail?: string }>({
    connected: false,
  });
  const { onHandle, onScreen } = props;
  const shownStatus: DeviceStreamStatus = accessError && !access ? "error" : status;
  const shownDetail = accessError && !access ? accessError : detail;

  useEffect(() => {
    const rejected = rejectedRef.current;
    if (!access || !rejected) return;
    if (access.expiresAt !== null && access.expiresAt === rejected.expiresAt) return;
    rejectedRef.current = null;
    authRestartAtRef.current = Date.now();
    setAuthEpoch((epoch) => epoch + 1);
  }, [access]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const initialAccess = accessRef.current;
    if (accessKey === null || initialAccess === null || !canvas || !props.visible) {
      setStatus("connecting");
      onHandle?.(null);
      return;
    }
    let latestAccess = initialAccess;
    const stream = createDeviceStreamClient(
      {
        platform: props.platform,
        deviceId: props.deviceId,
        // Keep the last good access if a refresh fails mid-stream.
        access: () => (latestAccess = accessRef.current ?? latestAccess),
      },
      createCanvasFrameSink(canvas, () => frameListenerRef.current?.()),
      {
        onDuoControl: setDuoControl,
        onDuoUnavailable: onPhoneUnavailable,
        onStatus: (next, nextDetail) => {
          setStatus(next);
          setDetail(nextDetail);
          if (next !== "connecting") setShowRestartNotice(false);
        },
        onScreen: (next) => {
          setScreen(next);
          onScreen?.(next);
        },
        onUnauthorized: () => {
          // A rejection right after a fresh credential is not an expired
          // ticket; stop and offer Reconnect instead of minting in a loop.
          if (Date.now() - authRestartAtRef.current < AUTH_RETRY_WINDOW_MS) {
            setStatus("error");
            setDetail("This environment rejected the device stream credentials.");
            return;
          }
          rejectedRef.current = { expiresAt: accessRef.current?.expiresAt ?? null };
          refreshDeviceHubAccess(props.environmentId);
        },
        onMjpegFallback: (url) => {
          setMjpegUrl(url);
          setMjpegGeneration((generation) => generation + 1);
        },
        onInputConnected: (connected, detail) => {
          setInputState({ connected, ...(detail ? { detail } : {}) });
          if (!connected) setShowRestartNotice(false);
          onHandle?.({
            pressButton: client.pressButton,
            rotate: client.rotate,
            inputConnected: connected,
          });
        },
      },
    );
    const client = gateDeviceInput(stream, () => inputEnabledRef.current);
    clientRef.current = client;
    setMjpegUrl(null);
    setInputState({ connected: false });
    client.start();
    onHandle?.({ pressButton: client.pressButton, rotate: client.rotate, inputConnected: false });
    return () => {
      cancelPhoneInput();
      client.stop();
      clientRef.current = null;
      onHandle?.(null);
      onScreen?.(null);
      setScreen(null);
    };
  }, [
    accessKey,
    authEpoch,
    cancelPhoneInput,
    onHandle,
    onPhoneUnavailable,
    onScreen,
    props.deviceId,
    props.environmentId,
    props.platform,
    props.visible,
  ]);

  // Losing control ends local gestures; the environment finishes any held input itself.
  useEffect(() => {
    if (inputEnabled) return;
    pointerActive.current = false;
    cancelPhoneInput();
  }, [cancelPhoneInput, inputEnabled]);

  // Displayed aspect ratio (width / height) of the device as the user sees it.
  const aspect = useMemo(() => {
    if (!screen) return props.aspectHint ?? (props.platform === "ios" ? 9 / 19.5 : 9 / 20);
    const landscape =
      screen.orientation === "landscape_left" || screen.orientation === "landscape_right";
    const w = landscape
      ? Math.max(screen.width, screen.height)
      : Math.min(screen.width, screen.height);
    const h = landscape
      ? Math.min(screen.width, screen.height)
      : Math.max(screen.width, screen.height);
    return w / h;
  }, [props.aspectHint, props.platform, screen]);

  // Android restarts its encoder when a fold changes the framebuffer size.
  // Keep the last decoded frame and viewer mounted while the next keyframe arrives.
  const retainingAndroidFrame =
    props.platform === "android" &&
    status === "connecting" &&
    inputState.connected &&
    screen !== null;
  const bezel = props.family === "watch" || props.family === "tv" ? props.family : null;
  const showPhone =
    props.allowPhoneView &&
    !bezel &&
    (status === "streaming" || retainingAndroidFrame) &&
    props.visible &&
    presentation === "phone" &&
    !phoneUnavailable &&
    !mjpegUrl &&
    !props.axOverlay &&
    (!isDuo || screen?.supportsHingeAngle === true);
  useEffect(() => {
    if (!retainingAndroidFrame || !showPhone) return;
    const timeout = window.setTimeout(() => setShowRestartNotice(true), 2_000);
    return () => window.clearTimeout(timeout);
  }, [retainingAndroidFrame, showPhone]);
  const controlsInset = props.renderControls && !showPhone ? CONTROLS_RAIL_WIDTH : 0;

  // The frame is the largest box at `aspect` that fits the container, so a
  // narrow panel shows a shorter phone rather than a squeezed one. CSS
  // `aspect-ratio` alone cannot do this: with the height pinned to 100% the
  // width clamp wins and distorts the drawn frame.
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [host, setHost] = useState({ width: 0, height: 0 });
  useEffect(() => {
    const element = hostRef.current;
    if (!element) return;
    const update = () => {
      const rect = element.getBoundingClientRect();
      setHost((current) =>
        current.width === rect.width && current.height === rect.height
          ? current
          : { width: rect.width, height: rect.height },
      );
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const frame = useMemo(() => {
    const inset = bezel ? BEZEL_INSET : 0;
    return fitDeviceFrame(aspect, host.width - inset, host.height - inset, controlsInset);
  }, [aspect, bezel, controlsInset, host]);

  // serve-sim streams the raw framebuffer; rotate the display for a device
  // that reports landscape while its frames stay portrait.
  const rotation = useMemo(() => {
    if (props.platform !== "ios" || !screen || screen.width > screen.height) return 0;
    switch (screen.orientation) {
      case "landscape_left":
        return 90;
      case "landscape_right":
        return -90;
      case "portrait_upside_down":
        return 180;
      default:
        return 0;
    }
  }, [props.platform, screen]);

  // A sideways rotation draws the raw portrait frame into a landscape box:
  // the media element takes the transposed size and is rotated about the
  // box's center.
  const sideways = rotation === 90 || rotation === -90;
  const mediaStyle: React.CSSProperties = sideways
    ? {
        width: frame.height,
        height: frame.width,
        left: (frame.width - frame.height) / 2,
        top: (frame.height - frame.width) / 2,
        transform: `rotate(${rotation}deg)`,
      }
    : {
        width: frame.width,
        height: frame.height,
        ...(rotation ? { transform: `rotate(${rotation}deg)` } : {}),
      };

  // The accessibility tree is polled while the overlay is on; each poll is
  // one JSON fetch, so there is nothing to repaint between polls.
  const [axElements, setAxElements] = useState<ReadonlyArray<DeviceAxElement>>([]);
  useEffect(() => {
    if (!props.axOverlay || !access || !props.visible) return;
    const target = { access, platform: props.platform, deviceId: props.deviceId };
    let controller: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    const poll = async () => {
      controller = new AbortController();
      try {
        const tree = await fetchDeviceAxTree(target, controller.signal);
        if (!stopped) setAxElements(tree.elements);
      } catch {
        // Keep the last good tree; the next poll retries.
      }
      if (!stopped) timer = setTimeout(() => void poll(), AX_POLL_INTERVAL_MS);
    };
    void poll();
    return () => {
      stopped = true;
      controller?.abort();
      if (timer) clearTimeout(timer);
      setAxElements([]);
    };
  }, [access, props.axOverlay, props.deviceId, props.platform, props.visible]);

  const pointerActive = useRef(false);
  const normalizedPoint = (event: React.PointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  };

  const phoneUnavailableReason = bezel
    ? `There is no 3D model for ${familyNoun(bezel)} yet`
    : isDuo && !screen?.supportsHingeAngle
      ? "iPhone Duo 3D requires Device Hub 0.11.0 or newer"
      : phoneUnavailable
        ? "3D is unavailable on this browser"
        : mjpegUrl
          ? "3D requires the H.264 stream"
          : props.axOverlay
            ? "Turn off accessibility frames to use 3D"
            : null;

  const keyboardSource = deviceKeyboard(props.platform, props.deviceName ?? "");
  const resetView = useCallback(() => {
    if (!isDuo) {
      const orientation = keyboardAttached ? "landscape_right" : "portrait";
      if (screen?.orientation !== orientation) clientRef.current?.setOrientation(orientation);
    }
    resetViewRef.current?.();
  }, [isDuo, keyboardAttached, screen?.orientation]);
  const profile = resolveDeviceShape({
    platform: props.platform,
    name: props.deviceName ?? "",
    portraitAspect: Math.min(aspect, 1 / aspect),
  });

  return (
    <div
      className={cn(
        "relative flex size-full min-h-0 min-w-0",
        props.allowPhoneView ? "bg-background" : "bg-black/90",
      )}
    >
      {props.renderControls ? (
        <DeviceControlsSlot
          renderControls={props.renderControls}
          view={{
            phone: !!showPhone,
            streaming: status === "streaming",
            phoneUnavailableReason,
            foldingControls:
              props.platform === "android" && access ? (
                <DeviceAndroidFoldControls
                  key={`${props.hostId}:${props.deviceId}`}
                  access={access}
                  deviceId={props.deviceId}
                  visible={props.visible}
                  enabled={status === "streaming"}
                  canChange={inputEnabled}
                  onControlError={
                    controlGeneration !== undefined && props.onControlError
                      ? (code) => props.onControlError?.(code, controlGeneration)
                      : undefined
                  }
                  screenWidth={screen?.width}
                  screenHeight={screen?.height}
                  onFoldAngle={setFoldAngle}
                />
              ) : showPhone && isDuo && screen?.supportsHingeAngle ? (
                <DeviceDuoControls
                  screen={screen}
                  state={duoControl}
                  enabled={inputState.connected && inputEnabled}
                  onCommand={(command) => {
                    cancelPhoneInput();
                    clientRef.current?.controlDuo(command);
                  }}
                />
              ) : null,
            keyboard:
              showPhone && keyboardSource
                ? {
                    attached: keyboardAttached,
                    disabled: !inputEnabled,
                    toggle: () => {
                      if (!inputEnabledRef.current) return;
                      cancelPhoneInput();
                      if (!keyboardAttached && screen?.orientation !== "landscape_right")
                        clientRef.current?.setOrientation("landscape_right");
                      setKeyboardAttached(!keyboardAttached);
                    },
                  }
                : null,
            showPhone: () => setPresentation("phone"),
            showFlat: () => setPresentation("flat"),
          }}
          onResetView={resetView}
        />
      ) : null}
      <div
        ref={hostRef}
        className={cn(
          "relative flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden outline-none",
          controlsInset && "pr-14",
        )}
        tabIndex={0}
        role="application"
        aria-label={
          bezel === "tv"
            ? "Apple TV screen. Use arrow keys, Enter, Escape, Space and Home as the Siri Remote."
            : bezel === "watch"
              ? "Apple Watch screen. Scroll to turn the Digital Crown."
              : `${props.platform === "ios" ? "iOS Simulator" : "Android Emulator"} screen`
        }
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget || !inputEnabled) return;
          if (bezel) {
            // Only mapped, unmodified keys reach a TV; other shortcuts keep theirs.
            const button =
              bezel === "tv" && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
                ? DEVICE_TV_KEYBOARD_MAP[event.code]
                : undefined;
            if (!button || !props.onRemoteButton || status !== "streaming") return;
            event.preventDefault();
            props.onRemoteButton(button);
            return;
          }
          if (event.metaKey && !["r", "R"].includes(event.key)) return;
          event.preventDefault();
          clientRef.current?.sendKey(event.nativeEvent, "down");
        }}
        onKeyUp={(event) => {
          if (event.target !== event.currentTarget || bezel) return;
          clientRef.current?.sendKey(event.nativeEvent, "up");
        }}
      >
        <div
          className={cn(
            "relative select-none",
            showPhone && "invisible pointer-events-none",
            // A clean drawn bezel from the framing hint; there is no Watch or TV model.
            bezel && "overflow-hidden ring-[10px] ring-neutral-900 dark:ring-neutral-800",
            bezel === "watch" && "rounded-[22%]",
            bezel === "tv" && "rounded-sm",
          )}
          style={{ width: frame.width, height: frame.height }}
          onWheel={(event) => {
            if (inputEnabled && props.onCrown && !event.ctrlKey) props.onCrown(crownDeltaFromWheel(event));
          }}
          onPointerDown={(event) => {
            if (!inputEnabled) return;
            (event.currentTarget.parentElement as HTMLElement | null)?.focus();
            // TV input is focus-engine buttons only; a click just focuses the screen.
            if (bezel === "tv") return;
            event.currentTarget.setPointerCapture(event.pointerId);
            pointerActive.current = true;
            const { x, y } = normalizedPoint(event);
            clientRef.current?.sendTouch("begin", x, y);
          }}
          onPointerMove={(event) => {
            if (!pointerActive.current) return;
            const { x, y } = normalizedPoint(event);
            clientRef.current?.sendTouch("move", x, y);
          }}
          onPointerUp={(event) => {
            if (!pointerActive.current) return;
            pointerActive.current = false;
            const { x, y } = normalizedPoint(event);
            clientRef.current?.sendTouch("end", x, y);
          }}
          onPointerCancel={(event) => {
            if (!pointerActive.current) return;
            pointerActive.current = false;
            const { x, y } = normalizedPoint(event);
            clientRef.current?.sendTouch("end", x, y);
          }}
        >
          <canvas
            ref={canvasRef}
            className={cn("absolute top-0 left-0", mjpegUrl && "hidden")}
            style={mediaStyle}
          />
          {props.visible && access && mjpegUrl ? (
            <img
              key={mjpegGeneration}
              ref={attachMjpegImage}
              alt=""
              draggable={false}
              className="absolute top-0 left-0 object-contain"
              style={mediaStyle}
            />
          ) : null}
          {axElements.length > 0 ? (
            <div className="pointer-events-none absolute inset-0" aria-hidden>
              {axElements.map((element) => (
                <div
                  key={element.id}
                  className="absolute border border-info/80 bg-info/10"
                  style={{
                    left: `${element.x * 100}%`,
                    top: `${element.y * 100}%`,
                    width: `${element.width * 100}%`,
                    height: `${element.height * 100}%`,
                  }}
                >
                  {element.label ? (
                    <span className="absolute -top-3.5 left-0 max-w-full truncate rounded-sm bg-info px-1 text-[9px] leading-3.5 text-white">
                      {element.label}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        {showPhone && isDuo && model ? (
          <DeviceDuoViewport
            onFrameListener={onFrameListener}
            model={model}
            controlError={duoControl.error}
            hingePreview={
              duoControl.requested?.control === "angle" ? duoControl.requested.value : null
            }
            source={canvasRef}
            client={clientRef}
            onInputCancel={onInputCancel}
            onResetReady={onResetReady}
            screen={screen}
            onUnavailable={onPhoneUnavailable}
          />
        ) : showPhone ? (
          <DevicePhoneViewport
            profile={profile}
            model={deviceModel(props.platform, props.deviceName ?? "")}
            accessory={keyboardAttached ? keyboardSource : null}
            source={canvasRef}
            onFrameListener={onFrameListener}
            client={clientRef}
            onInputCancel={onInputCancel}
            onResetReady={onResetReady}
            screen={screen}
            foldAngle={foldAngle}
            onUnavailable={onPhoneUnavailable}
          />
        ) : null}
        {props.allowPhoneView && !props.renderControls && status === "streaming" ? (
          <div className="absolute top-3 left-3 flex gap-1 rounded-lg border border-border/50 bg-background/90 p-1 shadow-sm">
            <Button
              variant={showPhone ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={!!showPhone}
              disabled={!!phoneUnavailableReason}
              title={phoneUnavailableReason ?? "Show 3D phone"}
              onClick={() => setPresentation("phone")}
            >
              3D
            </Button>
            <Button
              variant={!showPhone ? "secondary" : "ghost"}
              size="xs"
              aria-pressed={!showPhone}
              onClick={() => setPresentation("flat")}
            >
              Flat
            </Button>
          </div>
        ) : null}
        {status === "streaming" && !inputState.connected ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-2">
            <span className="rounded-md bg-background/85 px-2 py-1 text-xs text-muted-foreground">
              Input disconnected{inputState.detail ? ` (${inputState.detail})` : ""}, reconnecting…
            </span>
          </div>
        ) : null}
        {retainingAndroidFrame && showPhone && showRestartNotice ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-2">
            <span className="rounded-md bg-background/85 px-2 py-1 text-xs text-muted-foreground">
              Waiting for device video…
            </span>
          </div>
        ) : null}
        {shownStatus !== "streaming" && !(retainingAndroidFrame && showPhone) ? (
          <div className="absolute inset-0">
            <DeviceLoadingView
              name={props.deviceName ?? "Device"}
              description={props.deviceDescription ?? ""}
              stage="stream"
              message={
                shownStatus === "error" ? (shownDetail ?? "Stream failed.") : "Connecting video…"
              }
              error={shownStatus === "error"}
            >
              {shownStatus === "error" ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    authRestartAtRef.current = 0;
                    if (accessError) {
                      refreshDeviceHubAccess(props.environmentId);
                      return;
                    }
                    // An expired ticket surfaces as unauthorized on restart and
                    // refreshes access through the effect; no need to mint one here.
                    // Drop the MJPEG fallback too, or a recovered H.264 stream
                    // would decode behind a canvas still hidden for MJPEG.
                    clientRef.current?.stop();
                    setMjpegUrl(null);
                    clientRef.current?.start();
                  }}
                >
                  Reconnect
                </Button>
              ) : null}
            </DeviceLoadingView>
          </div>
        ) : null}
      </div>
    </div>
  );
}

const gateDeviceInput = (
  client: DeviceStreamClient,
  enabled: () => boolean,
): DeviceStreamClient => {
  const gate =
    <A extends ReadonlyArray<unknown>>(send: (...args: A) => void) =>
    (...args: A) => {
      if (enabled()) send(...args);
    };
  return {
    ...client,
    sendTouch: gate(client.sendTouch),
    sendRawTouch: gate(client.sendRawTouch),
    sendKey: gate(client.sendKey),
    pressButton: gate(client.pressButton),
    rotate: gate(client.rotate),
    setOrientation: gate(client.setOrientation),
    controlDuo: gate(client.controlDuo),
  };
};

function DeviceControlsSlot(props: {
  renderControls: (view: DeviceViewControls) => ReactNode;
  view: Omit<DeviceViewControls, "resetView">;
  onResetView: () => void;
}) {
  return props.renderControls({ ...props.view, resetView: props.onResetView });
}
