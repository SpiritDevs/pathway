import { GhosttyTerminalSurface } from "../../web/src/terminal/ghostty/surface";

type NativeMessage =
  | { type: "ready" }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "copy"; data: string }
  | { type: "error"; message: string };

declare global {
  interface Window {
    webkit?: { messageHandlers: { terminal: { postMessage: (message: NativeMessage) => void } } };
    pathwayTerminal?: { receive: (commands: readonly Command[]) => void; dispose: () => void };
  }
}
type Command = {
  kind: "write" | "reset" | "paste" | "copy" | "focus" | "enabled";
  data?: string;
  enabled?: boolean;
};

let enabled = false;
let disposed = false;
let surface: GhosttyTerminalSurface | undefined;
const post = (message: NativeMessage) => {
  // WebKit's native message handler takes one argument; this is not window.postMessage.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  if (!disposed) window.webkit?.messageHandlers.terminal.postMessage(message);
};
const dispose = () => {
  disposed = true;
  surface?.dispose();
  surface = undefined;
};
window.addEventListener("pagehide", dispose, { once: true });
// Terminal text is data. OSC links are deliberately inert in this renderer.
window.open = () => null;

async function start() {
  const mount = document.getElementById("terminal");
  if (!mount) throw new Error("Terminal mount is missing");
  const created = await GhosttyTerminalSurface.create(mount, {
    theme: {
      background: { r: 20, g: 22, b: 25 },
      foreground: { r: 227, g: 229, b: 232 },
      cursor: { r: 227, g: 229, b: 232 },
    },
    font: { size: 14 },
    onData: (data) => {
      if (enabled && data.length > 0) post({ type: "input", data });
    },
    onResize: (cols, rows) => post({ type: "resize", cols, rows }),
    onSelectionChange: () => {},
    onCopy: (data) => post({ type: "copy", data }),
    // Keyboard copy/selection remain available while terminal writes are disabled.
    beforeKey: () => true,
    onLinkActivate: (_text, event) => event.preventDefault(),
  });
  if (disposed) {
    created.dispose();
    return;
  }
  surface = created;
  // Native PasteButton owns clipboard access; this preserves bracketed paste.
  window.pathwayTerminal = {
    receive(commands) {
      for (const command of commands) {
        switch (command.kind) {
          case "write":
            created.write(command.data ?? "");
            break;
          case "reset":
            created.resetAndWrite(command.data ?? "");
            break;
          case "paste":
            if (enabled) void created.pasteFromClipboard(async () => command.data ?? "");
            break;
          case "copy":
            post({ type: "copy", data: created.getSelection() });
            break;
          case "focus":
            created.focus();
            break;
          case "enabled":
            enabled = command.enabled === true;
            created.input.readOnly = !enabled;
            break;
        }
      }
    },
    dispose,
  };
  post({ type: "ready" });
}
void start().catch((error: unknown) =>
  post({
    type: "error",
    message: error instanceof Error ? error.message : "Terminal could not start",
  }),
);
