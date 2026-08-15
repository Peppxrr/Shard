// preload.ts — narrow contextBridge surface (window.clipforge).
import { contextBridge, ipcRenderer } from "electron";
import type { ClipforgeApi, ClipRecord, ExportProgress, Settings } from "../shared/contracts";

const api: ClipforgeApi = {
  invoke: (method: string, params?: Record<string, unknown>) =>
    ipcRenderer.invoke("core:invoke", method, params ?? {}),

  onCoreEvent: (cb) => {
    const listener = (_e: unknown, type: string, params: Record<string, unknown>) => cb(type, params);
    ipcRenderer.on("core:event", listener);
    return () => ipcRenderer.removeListener("core:event", listener);
  },

  getSettings: () => ipcRenderer.invoke("settings:get") as Promise<Settings>,
  setSettings: (s: Settings) => ipcRenderer.invoke("settings:set", s) as Promise<void>,

  listClips: () => ipcRenderer.invoke("library:list") as Promise<ClipRecord[]>,
  deleteClip: (id: string) => ipcRenderer.invoke("library:delete", id) as Promise<void>,
  setProtected: (id: string, prot: boolean) => ipcRenderer.invoke("library:protect", id, prot) as Promise<void>,
  probeTracks: (p: string) => ipcRenderer.invoke("library:tracks", p) as Promise<{ index: number; codec: string }[]>,
  onLibraryChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on("library:changed", listener);
    return () => ipcRenderer.removeListener("library:changed", listener);
  },
  revealInExplorer: (p: string) => ipcRenderer.send("shell:reveal", p),
  openClip: (p: string) => ipcRenderer.send("shell:open", p),
  startDrag: (p: string, iconPath?: string) => ipcRenderer.send("drag:start", p, iconPath),

  startExport: (clipId: string, segments?: { start: number; end: number }[], audioTracks?: number[]) => {
    if (segments) ipcRenderer.send("export:segments", clipId, segments, audioTracks);
    return ipcRenderer.invoke("export:start", clipId) as Promise<void>;
  },
  cancelExport: () => ipcRenderer.invoke("export:cancel") as Promise<void>,
  onExport: (cb) => {
    const listener = (_e: unknown, p: ExportProgress) => cb(p);
    ipcRenderer.on("export:progress", listener);
    return () => ipcRenderer.removeListener("export:progress", listener);
  },

  version: () => ipcRenderer.invoke("app:version") as Promise<string>,

  onToast: (cb) => {
    const listener = (_e: unknown, message: string) => cb(message);
    ipcRenderer.on("toast", listener);
    return () => ipcRenderer.removeListener("toast", listener);
  },
};

contextBridge.exposeInMainWorld("clipforge", api);
