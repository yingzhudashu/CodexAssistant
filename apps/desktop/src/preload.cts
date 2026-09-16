const { contextBridge, ipcRenderer } =
  require("electron") as typeof import("electron");
import type { TaskSnapshot } from "@codex-assistant/protocol";

/**
 * sandbox renderer 使用 CommonJS preload。Electron 会为 sandbox preload
 * 提供受限的 require，这比 ESM preload 在当前 Electron 版本中的加载行为稳定。
 */
contextBridge.exposeInMainWorld("codexAssistant", {
  getConnection: () =>
    ipcRenderer.invoke("connection.get") as Promise<{
      configured: boolean;
      apiUrl?: string;
      deviceId?: string;
    }>,
  saveConnection: (input: { apiUrl: string; token: string }) =>
    ipcRenderer.invoke("connection.save", input),
  getInteractions: () => ipcRenderer.invoke("interactions.get"),
  submitInteraction: (input: unknown) =>
    ipcRenderer.invoke("interaction.submit", input),
  getTasks: () => ipcRenderer.invoke("tasks.get") as Promise<TaskSnapshot[]>,
  getSyncStatus: () =>
    ipcRenderer.invoke("sync.status") as Promise<
      "connecting" | "syncing" | "connected" | "offline"
    >,
  getWorkstationStatus: () =>
    ipcRenderer.invoke("workstation.status") as Promise<{ ready: boolean }>,
  getTaskDetail: (input: { threadId: string; cursor?: string }) =>
    ipcRenderer.invoke("task.detail", input) as Promise<{
      turns: unknown[];
      cursor?: string;
    }>,
  sendTaskMessage: (input: { threadId: string; text: string }) =>
    ipcRenderer.invoke("task.send", input) as Promise<{ status: string }>,
  checkUpdate: () =>
    ipcRenderer.invoke("update.check") as Promise<{
      currentVersion: string;
      latestVersion: string;
      available: boolean;
      windowsUrl?: string;
      androidUrl?: string;
    }>,
  downloadUpdate: (target: "windows" | "android") =>
    ipcRenderer.invoke("update.download", target) as Promise<{
      opened: boolean;
    }>,
  onTasks: (listener: (tasks: TaskSnapshot[]) => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      tasks: TaskSnapshot[],
    ) => listener(tasks);
    ipcRenderer.on("tasks.updated", handler);
    return () => ipcRenderer.removeListener("tasks.updated", handler);
  },
  onSyncStatus: (
    listener: (
      status: "connecting" | "syncing" | "connected" | "offline",
    ) => void,
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      status: "connecting" | "syncing" | "connected" | "offline",
    ) => listener(status);
    ipcRenderer.on("sync.status", handler);
    return () => ipcRenderer.removeListener("sync.status", handler);
  },
});
