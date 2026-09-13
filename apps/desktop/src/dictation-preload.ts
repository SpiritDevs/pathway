import { contextBridge, ipcRenderer } from "electron";
import { createDictationPreloadBridge } from "./dictation/preloadBridge.ts";
import { DICTATION_RESIZE } from "./dictation/channels.ts";

contextBridge.exposeInMainWorld("dictationOverlay", {
  ...createDictationPreloadBridge(),
  resize: (width: number, height: number) => ipcRenderer.send(DICTATION_RESIZE, { width, height }),
});
