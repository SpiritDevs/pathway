/**
 * Device viewer page for the native iOS app. Swift loads an empty document at
 * the environment's origin, injects this script, and drives it through
 * `window.pathwayDeviceStream`. Replies go to the `deviceStream` message handler.
 */
import {
  createDeviceStreamClient,
  type DeviceScreenSize,
  type DeviceStreamClient,
} from "../../../packages/client-runtime/src/device/stream.ts";
import type { DeviceHubAccess } from "../../../packages/client-runtime/src/device/hubAccess.ts";

export interface DeviceStreamConfiguration {
  readonly platform: "ios" | "android";
  readonly deviceId: string;
  readonly access: DeviceHubAccess;
  readonly inputEnabled: boolean;
}

export type DeviceStreamMessage =
  | { readonly type: "status"; readonly status: "connecting" | "streaming" | "error" }
  | { readonly type: "input"; readonly connected: boolean }
  | { readonly type: "unauthorized" };

export type DeviceStreamCommand = "home" | "back" | "appSwitcher" | "rotate";

declare global {
  interface Window {
    pathwayDeviceStream?: {
      start: (configuration: DeviceStreamConfiguration) => void;
      stop: () => void;
      command: (command: DeviceStreamCommand) => void;
      setInputEnabled: (enabled: boolean) => void;
    };
  }
}

// `window.webkit` is typed per page; the terminal page declares its own handler.
const nativeBridge = (
  window as unknown as {
    webkit?: { messageHandlers: { deviceStream?: { postMessage: (message: unknown) => void } } };
  }
).webkit?.messageHandlers.deviceStream;
// oxlint-disable-next-line unicorn/require-post-message-target-origin -- WebKit message handlers take no origin.
const post = (message: DeviceStreamMessage) => nativeBridge?.postMessage(message);

let activeClient: DeviceStreamClient | null = null;
let inputEnabled = false;

export function stop() {
  activeClient?.stop();
  activeClient = null;
}

export function command(button: DeviceStreamCommand) {
  if (!inputEnabled) return;
  if (button === "rotate") activeClient?.rotate();
  else activeClient?.pressButton(button);
}

export function setInputEnabled(enabled: boolean) {
  inputEnabled = enabled;
}

/** Rotation the iOS stream needs when the simulator reports landscape on a portrait framebuffer. */
export function deviceLayout(platform: "ios" | "android", screen: DeviceScreenSize | null) {
  const landscape =
    screen?.orientation === "landscape_left" || screen?.orientation === "landscape_right";
  const aspect = screen
    ? landscape
      ? Math.max(screen.width, screen.height) / Math.min(screen.width, screen.height)
      : Math.min(screen.width, screen.height) / Math.max(screen.width, screen.height)
    : 9 / 19.5;
  const rotation =
    platform === "ios" && screen && screen.width <= screen.height
      ? screen.orientation === "landscape_left"
        ? 90
        : screen.orientation === "landscape_right"
          ? -90
          : screen.orientation === "portrait_upside_down"
            ? 180
            : 0
      : 0;
  return { aspect, rotation };
}

export function start(configuration: DeviceStreamConfiguration) {
  stop();
  const { platform } = configuration;
  inputEnabled = configuration.inputEnabled;
  const container = document.createElement("div");
  Object.assign(container.style, {
    position: "fixed",
    inset: "0",
    containerType: "size",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  });
  const frame = document.createElement("div");
  frame.setAttribute("role", "application");
  frame.setAttribute(
    "aria-label",
    platform === "ios" ? "iOS Simulator screen" : "Android Emulator screen",
  );
  frame.tabIndex = 0;
  Object.assign(frame.style, {
    position: "relative",
    touchAction: "none",
    userSelect: "none",
    webkitUserSelect: "none",
    webkitTouchCallout: "none",
    outline: "none",
  });
  const canvas = document.createElement("canvas");
  const image = document.createElement("img");
  image.alt = "";
  image.draggable = false;
  image.style.display = "none";
  frame.append(canvas, image);
  container.append(frame);
  document.body.replaceChildren(container);

  const layout = (screen: DeviceScreenSize | null) => {
    const { aspect, rotation } = deviceLayout(platform, screen);
    const sideways = Math.abs(rotation) === 90;
    frame.style.width = `min(100cqw, ${aspect * 100}cqh)`;
    frame.style.height = `min(100cqh, ${100 / aspect}cqw)`;
    for (const media of [canvas, image]) {
      Object.assign(media.style, {
        position: "absolute",
        width: sideways ? `${100 / aspect}%` : "100%",
        height: sideways ? `${100 * aspect}%` : "100%",
        left: "50%",
        top: "50%",
        transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
        pointerEvents: "none",
      });
    }
  };
  layout(null);

  let inputConnected = false;
  const client = createDeviceStreamClient(
    { platform, deviceId: configuration.deviceId, access: configuration.access },
    canvas,
    {
      onStatus: (status) => post({ type: "status", status }),
      onScreen: layout,
      onMjpegFallback: () => {
        canvas.style.display = "none";
        image.style.display = "block";
        client.setMjpegImage(image);
      },
      onUnauthorized: () => {
        if (activeClient === client) post({ type: "unauthorized" });
      },
      onInputConnected: (connected) => {
        inputConnected = connected;
        post({ type: "input", connected });
      },
    },
  );
  activeClient = client;

  let pointerId: number | null = null;
  const touch = (event: PointerEvent, phase: "begin" | "move" | "end") => {
    const rect = frame.getBoundingClientRect();
    client.sendTouch(
      phase,
      Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
    );
  };
  frame.addEventListener("pointerdown", (event) => {
    if (!inputEnabled || !inputConnected || pointerId !== null) return;
    event.preventDefault();
    pointerId = event.pointerId;
    frame.setPointerCapture(event.pointerId);
    frame.focus();
    touch(event, "begin");
  });
  frame.addEventListener("pointermove", (event) => {
    if (pointerId === event.pointerId) touch(event, "move");
  });
  const endTouch = (event: PointerEvent) => {
    if (pointerId !== event.pointerId) return;
    pointerId = null;
    touch(event, "end");
  };
  frame.addEventListener("pointerup", endTouch);
  frame.addEventListener("pointercancel", endTouch);
  frame.addEventListener("lostpointercapture", endTouch);
  frame.addEventListener("keydown", (event) => {
    if (!inputEnabled) return;
    event.preventDefault();
    client.sendKey(event, "down");
  });
  frame.addEventListener("keyup", (event) => {
    if (inputEnabled) client.sendKey(event, "up");
  });
  post({ type: "input", connected: false });
  client.start();
}

window.pathwayDeviceStream = { start, stop, command, setInputEnabled };
window.addEventListener("pagehide", stop);
