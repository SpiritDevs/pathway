import { ipcRenderer } from "electron";
import type { DictationBridge, DictationState } from "@spiritdevs/contracts/dictation";
import * as channels from "./channels.ts";

export function createDictationPreloadBridge(): DictationBridge {
  return {
    getState: () => ipcRenderer.invoke(channels.DICTATION_GET_STATE),
    execute: (command) => ipcRenderer.invoke(channels.DICTATION_EXECUTE, command),
    listHistory: () => ipcRenderer.invoke(channels.DICTATION_HISTORY),
    onState(listener) {
      let current: DictationState | undefined;
      let active = true;
      const state = (_event: Electron.IpcRendererEvent, value: DictationState) => {
        if (!active) return;
        current = value;
        listener(value);
      };
      const meter = (
        _event: Electron.IpcRendererEvent,
        value: { durationMs: number; level: number },
      ) => {
        if (!active || !current) return;
        current = { ...current, durationMs: value.durationMs, level: value.level };
        listener(current);
      };
      ipcRenderer.on(channels.DICTATION_STATE, state);
      ipcRenderer.on(channels.DICTATION_METER, meter);
      // A listener attached during recording may only receive meter events until it stops.
      void ipcRenderer.invoke(channels.DICTATION_GET_STATE).then(
        (value: DictationState) => {
          if (!active || current) return;
          current = value;
          listener(value);
        },
        () => {},
      );
      return () => {
        active = false;
        ipcRenderer.removeListener(channels.DICTATION_STATE, state);
        ipcRenderer.removeListener(channels.DICTATION_METER, meter);
      };
    },
    onNavigate(listener) {
      const receive = (
        _event: Electron.IpcRendererEvent,
        page: "models" | "history" | "dictionary" | "settings",
      ) => {
        if (["models", "history", "dictionary", "settings"].includes(page)) listener(page);
      };
      ipcRenderer.on(channels.DICTATION_NAVIGATE, receive);
      return () => ipcRenderer.removeListener(channels.DICTATION_NAVIGATE, receive);
    },
  };
}
