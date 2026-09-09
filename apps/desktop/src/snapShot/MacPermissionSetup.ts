// @effect-diagnostics nodeBuiltinImport:off -- Native Electron window and application bundle boundary.
import * as NodePath from "node:path";
import * as Electron from "electron";

type MacPermissionAction = "allow-screen-recording" | "allow-accessibility";

const permissionSettings = {
  "allow-screen-recording": {
    title: "Screen Recording",
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
  },
  "allow-accessibility": {
    title: "Accessibility",
    url: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
  },
} as const;

// Use the running bundle, including renamed installs and Electron.app during development.
export function macPermissionAppBundle(executablePath: string): string {
  const bundle = /^(.*\.app)\/Contents\/MacOS\/[^/]+$/.exec(executablePath)?.[1];
  if (!bundle) throw new Error("Could not locate the running macOS app bundle.");
  return bundle;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
}

export function macPermissionSetupHtml(appName: string, title: string, icon: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">
<style>
:root { color-scheme: light dark; font: 13px -apple-system, BlinkMacSystemFont, sans-serif; }
* { box-sizing: border-box; }
body { margin: 0; padding: 18px; background: light-dark(#f4f1f5, #272529); color: light-dark(#262329, #f6f3f7); user-select: none; }
header { display: flex; align-items: center; gap: 12px; -webkit-app-region: drag; }
button { color: inherit; font: inherit; border: 0; cursor: pointer; -webkit-app-region: no-drag; }
#back { border-radius: 50%; width: 30px; height: 30px; background: light-dark(#e8e4e9, #3b383e); font-size: 22px; }
h1 { margin: 0; font-size: 14px; font-weight: 600; }
p { margin: 5px 0 0; color: light-dark(#65606a, #bcb6c1); line-height: 1.4; }
#app { display: flex; align-items: center; gap: 12px; width: 100%; margin-top: 14px; padding: 10px 14px; border: 1px solid light-dark(#ded8e1, #514b56); border-radius: 10px; background: light-dark(#fffaff, #38333d); text-align: left; cursor: grab; }
#app:active { cursor: grabbing; }
#app img { width: 36px; height: 36px; pointer-events: none; }
#app span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 15px; }
button:focus-visible { outline: 3px solid #3395ff; outline-offset: 2px; }
</style></head><body>
<header><button id="back" aria-label="Back to Pathway">‹</button><div>
<h1>Drag ${escapeHtml(appName)} into the ${escapeHtml(title)} list</h1>
<p>Then turn on its switch in System Settings.</p></div></header>
<button id="app" draggable="true" aria-label="Drag ${escapeHtml(appName)} into System Settings. Click to show the app in Finder.">
<img src="${escapeHtml(icon)}" alt="" draggable="false"><span>${escapeHtml(appName)}</span></button>
</body></html>`;
}

let activePanel: Electron.BrowserWindow | undefined;

/** Keeps the real app bundle within reach while System Settings is in front. */
export async function showMacPermissionSetup(
  owner: Electron.BrowserWindow,
  action: MacPermissionAction,
): Promise<void> {
  const bundle = macPermissionAppBundle(Electron.app.getPath("exe"));
  const icon = await Electron.app.getFileIcon(bundle, { size: "normal" });
  if (icon.isEmpty()) throw new Error("Could not load the app icon for permission setup.");
  if (owner.isDestroyed()) return;
  activePanel?.close();
  const workArea = Electron.screen.getDisplayMatching(owner.getBounds()).workArea;
  const width = Math.min(600, workArea.width);
  const height = 164;
  const panel = new Electron.BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: workArea.y + workArea.height - height - 24,
    title: `Allow ${permissionSettings[action].title}`,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: NodePath.join(__dirname, "mac-permission-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  activePanel = panel;
  const close = () => {
    if (!panel.isDestroyed()) panel.close();
  };
  const back = () => {
    close();
    if (!owner.isDestroyed()) {
      owner.show();
      owner.focus();
    }
  };
  owner.on("focus", close);
  owner.on("closed", close);
  owner.on("hide", close);
  owner.webContents.on("did-start-navigation", close);
  panel.once("closed", () => {
    if (activePanel === panel) activePanel = undefined;
    owner.removeListener("focus", close);
    owner.removeListener("closed", close);
    owner.removeListener("hide", close);
    owner.webContents.removeListener("did-start-navigation", close);
  });
  panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  panel.webContents.on("will-navigate", (event) => event.preventDefault());
  panel.webContents.on("ipc-message", (event, channel) => {
    if (event.senderFrame !== panel.webContents.mainFrame) return;
    if (channel === "mac-permission:drag") {
      panel.webContents.startDrag({ file: bundle, icon });
    } else if (channel === "mac-permission:back") {
      back();
    } else if (channel === "mac-permission:reveal") {
      Electron.shell.showItemInFolder(bundle);
    }
  });
  try {
    await panel.loadURL(
      `data:text/html;charset=utf-8,${encodeURIComponent(
        macPermissionSetupHtml(
          NodePath.basename(bundle, ".app"),
          permissionSettings[action].title,
          icon.toDataURL(),
        ),
      )}`,
    );
    if (panel.isDestroyed()) return;
    await Electron.shell.openExternal(permissionSettings[action].url);
    if (!panel.isDestroyed()) panel.showInactive();
  } catch (error) {
    close();
    throw error;
  }
}
