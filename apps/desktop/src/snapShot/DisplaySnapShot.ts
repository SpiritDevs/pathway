import * as Electron from "electron";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { captureMacScreenSnapshot } from "./MacSnapShot.ts";
import type { RegionSnapShotPool } from "./RegionSnapShot.ts";

const Selection = Schema.Struct({
  x: Schema.Number.check(Schema.isFinite()),
  y: Schema.Number.check(Schema.isFinite()),
  width: Schema.Number.check(Schema.isFinite()),
  height: Schema.Number.check(Schema.isFinite()),
});
const decodeSelection = Schema.decodeUnknownSync(Selection);

export class SnapShotRegionCancelled extends Error {
  constructor() {
    super("Region capture cancelled.");
  }
}

export class SnapShotRegionPicker {
  private readonly platform: NodeJS.Platform;
  private cancelCurrent: (() => void) | undefined;

  constructor(platform: NodeJS.Platform) {
    this.platform = platform;
  }

  close(): void {
    this.cancelCurrent?.();
  }

  /** Select over the live desktop; acquisition starts only after this window closes. */
  async select(bounds: Electron.Rectangle, scaleFactor = 1): Promise<Electron.Rectangle> {
    this.close();
    const window = new Electron.BrowserWindow({
      ...bounds,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      show: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      enableLargerThanScreen: true,
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        zoomFactor: 1,
      },
    });
    window.setMenu(null);
    window.setAlwaysOnTop(true, "screen-saver");
    if (this.platform === "darwin")
      window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    const result = Promise.withResolvers<Electron.Rectangle>();
    let settled = false;
    const finish = (selection?: Electron.Rectangle, error?: unknown) => {
      if (settled) return;
      settled = true;
      this.cancelCurrent = undefined;
      if (!window.isDestroyed()) window.destroy();
      if (selection) result.resolve(selection);
      else result.reject(error ?? new SnapShotRegionCancelled());
    };
    this.cancelCurrent = () => finish();
    window.once("closed", () => finish());
    window.webContents.once("render-process-gone", () =>
      finish(undefined, new Error("The region selector closed unexpectedly.")),
    );
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, target) => {
      event.preventDefault();
      try {
        const url = new URL(target);
        if (url.protocol !== "pathway-snapshot-region:") return;
        if (url.hostname === "cancel") return finish();
        if (url.hostname !== "select") return;
        const selection = decodeSelection(
          Object.fromEntries(
            ["x", "y", "width", "height"].map((key) => [key, Number(url.searchParams.get(key))]),
          ),
        );
        if (
          selection.width < 2 ||
          selection.height < 2 ||
          selection.x < 0 ||
          selection.y < 0 ||
          selection.x + selection.width > bounds.width + 1 ||
          selection.y + selection.height > bounds.height + 1
        )
          return;
        finish(selection);
      } catch {
        finish();
      }
    });
    const html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>
      *{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;cursor:crosshair;user-select:none;background:transparent}body{font:13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif}#selection{position:absolute;border:1px solid white;outline:1px solid #0008;box-shadow:0 0 0 100000px #0003;display:none;pointer-events:none}#coordinates{position:absolute;background:#222e;color:white;padding:4px 7px;border-radius:4px;white-space:nowrap;pointer-events:none;font-variant-numeric:tabular-nums}#help{position:absolute;left:50%;bottom:30px;transform:translateX(-50%);padding:10px 16px;background:#222e;color:white;border-radius:7px;pointer-events:none}
      </style></head><body><div id="selection"></div><div id="coordinates"></div><div id="help">Drag to capture a region · Esc to cancel</div><script>
      let start,rect;const scaleFactor=${JSON.stringify(scaleFactor)},box=document.getElementById('selection'),coordinates=document.getElementById('coordinates');const clamp=(v,max)=>Math.max(0,Math.min(v,max));
      const update=event=>{const x=clamp(event.clientX,innerWidth),y=clamp(event.clientY,innerHeight);if(start){rect={x:Math.min(start.x,x),y:Math.min(start.y,y),width:Math.abs(x-start.x),height:Math.abs(y-start.y)};Object.assign(box.style,{display:'block',left:rect.x+'px',top:rect.y+'px',width:rect.width+'px',height:rect.height+'px'})}coordinates.textContent='X '+Math.round(x*scaleFactor)+'  Y '+Math.round(y*scaleFactor)+(start?' · '+Math.round(rect.width*scaleFactor)+' × '+Math.round(rect.height*scaleFactor)+' px':' px');coordinates.style.left=clamp(x+16,innerWidth-coordinates.offsetWidth-8)+'px';coordinates.style.top=clamp(y+20,innerHeight-coordinates.offsetHeight-8)+'px'};
      document.addEventListener('pointerdown',event=>{if(event.button!==0)return;rect=undefined;start={x:clamp(event.clientX,innerWidth),y:clamp(event.clientY,innerHeight)};document.body.setPointerCapture(event.pointerId);update(event)});
      document.addEventListener('pointermove',update);
      document.addEventListener('pointerup',event=>{if(!start)return;update(event);start=undefined;if(rect&&rect.width>=2&&rect.height>=2)location.href='pathway-snapshot-region://select?'+new URLSearchParams(rect);else{rect=undefined;box.style.display='none'}});
      document.addEventListener('keydown',event=>{if(event.key==='Escape')location.href='pathway-snapshot-region://cancel'});document.addEventListener('contextmenu',event=>{event.preventDefault();location.href='pathway-snapshot-region://cancel'});
      </script></body></html>`;
    // Attach the rejection handler before loading, so closing while loading is safe.
    void result.promise.catch(() => undefined);
    try {
      await window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      if (!settled && !window.isDestroyed()) {
        window.setBounds(bounds);
        window.show();
        window.focus();
      }
    } catch (error) {
      finish(undefined, error);
    }
    return result.promise;
  }
}

export async function captureDisplaySnapshot(options: {
  readonly type: "screen" | "region";
  readonly platform: NodeJS.Platform;
  readonly imageTempPath: string;
  readonly pool: Pick<RegionSnapShotPool, "capture">;
  readonly picker: SnapShotRegionPicker;
  readonly maxSize: Electron.Size;
  readonly isCurrentAccount: () => boolean;
}) {
  if (options.platform !== "darwin" && options.platform !== "win32") {
    throw new Error("Screen and region capture are not available in this desktop session.");
  }
  const display = Electron.screen.getDisplayNearestPoint(Electron.screen.getCursorScreenPoint());
  if (!options.isCurrentAccount()) throw new SnapShotRegionCancelled();
  let captureBounds = display.bounds;
  if (options.type === "region") {
    const selection = await options.picker.select(display.bounds, display.scaleFactor);
    if (!options.isCurrentAccount()) throw new SnapShotRegionCancelled();
    captureBounds = {
      x: display.bounds.x + selection.x,
      y: display.bounds.y + selection.y,
      width: Math.round(selection.width),
      height: Math.round(selection.height),
    };
  }
  const captured =
    options.platform === "darwin"
      ? await captureMacScreenSnapshot(captureBounds, options.imageTempPath)
      : (await options.pool.capture(captureBounds)).png;
  const capturedAt = DateTime.formatIso(DateTime.nowUnsafe());
  if (!options.isCurrentAccount()) throw new SnapShotRegionCancelled();
  let image = Electron.nativeImage.createFromBuffer(captured);
  if (image.isEmpty()) throw new Error("The display returned an empty image.");
  const size = image.getSize();
  const scale = Math.min(
    options.maxSize.width / size.width,
    options.maxSize.height / size.height,
    Math.sqrt(40_000_000 / (size.width * size.height)),
    1,
  );
  if (scale < 1)
    image = image.resize({
      width: Math.max(1, Math.floor(size.width * scale)),
      height: Math.max(1, Math.floor(size.height * scale)),
      quality: "best",
    });
  return {
    source: { name: options.type === "region" ? "Screen region" : display.label || "Screen" },
    png: image.toPNG(),
    captureBounds,
    capturedAt,
  };
}
