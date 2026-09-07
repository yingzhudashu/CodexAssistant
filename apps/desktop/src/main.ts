import { join } from "node:path";
import { app, BrowserWindow, ipcMain, Menu, nativeImage, Tray } from "electron";
import { loadDesktopConnection, saveDesktopConnection } from "./desktop-config.js";
import { Monitor, type MonitorStatus } from "./monitor.js";
import type { TaskSnapshot } from "@codex-assistant/protocol";

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let monitor: Monitor | undefined;
let latestTasks: TaskSnapshot[] = [];
let monitorStatus: MonitorStatus = "connecting";
let quitting = false;

function assertTrustedSender(event: Electron.IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url;
  if (!url || (!url.startsWith("file://") && !url.startsWith("http://127.0.0.1") && !url.startsWith("http://localhost"))) throw new Error("DESKTOP_IPC_SENDER_DENIED");
}
function createWindow(): BrowserWindow {
  const next = new BrowserWindow({ width: 430, height: 700, minWidth: 360, minHeight: 480, show: false, resizable: true, webPreferences: { preload: join(import.meta.dirname, "preload.cjs"), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  void next.loadFile(join(import.meta.dirname, "renderer", "index.html")).catch((error: unknown) => {
    console.error("CodexAssistant renderer load failed", error);
    if (!next.isDestroyed()) next.show();
  });
  next.webContents.on("render-process-gone", (_event, details) => console.error("CodexAssistant renderer exited", details.reason));
  next.webContents.on("did-fail-load", (_event, code, description) => console.error("CodexAssistant renderer navigation failed", code, description));
  next.once("ready-to-show", () => next.show());
  next.on("closed", () => { window = undefined; });
  return next;
}
function showWindow(): void {
  if (!window || window.isDestroyed()) window = createWindow();
  else if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
function createTray(): void {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip("CodexAssistant");
  tray.setContextMenu(Menu.buildFromTemplate([{ label: "打开 CodexAssistant", click: showWindow }, { label: "退出", click: () => app.quit() }]));
  tray.on("double-click", showWindow);
}
async function startMonitor(): Promise<void> {
  const connection = await loadDesktopConnection();
  if (!connection.configured || !connection.apiUrl || !connection.token || !connection.deviceId) return;
  monitor = await Monitor.create({ stateDirectory: join(app.getPath("userData"), "state"), apiUrl: connection.apiUrl, token: connection.token, deviceId: connection.deviceId, onTasks: (tasks) => { latestTasks = tasks; window?.webContents.send("tasks.updated", tasks); }, onStatus: (status) => { monitorStatus = status; window?.webContents.send("sync.status", status); } });
  await monitor.start();
}
function registerIpc(): void {
  ipcMain.handle("connection.get", async (event) => { assertTrustedSender(event); const value = await loadDesktopConnection(); return { configured: value.configured, apiUrl: value.apiUrl, deviceId: value.deviceId }; });
  ipcMain.handle("connection.save", async (event, input: unknown) => { assertTrustedSender(event); if (!input || typeof input !== "object") throw new Error("DESKTOP_CONNECTION_INVALID"); const value = input as Record<string, unknown>; if (typeof value.apiUrl !== "string" || typeof value.token !== "string") throw new Error("DESKTOP_CONNECTION_INVALID"); await monitor?.stop(); const saved = await saveDesktopConnection({ apiUrl: value.apiUrl, token: value.token }); await startMonitor(); return { configured: saved.configured, apiUrl: saved.apiUrl, deviceId: saved.deviceId }; });
  ipcMain.handle("tasks.get", (event) => { assertTrustedSender(event); return latestTasks; });
  ipcMain.handle("sync.status", (event) => { assertTrustedSender(event); return monitorStatus; });
}
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on("second-instance", showWindow);
  app.whenReady().then(async () => { app.setAppUserModelId("site.robotclaw.codexassistant"); app.setLoginItemSettings({ openAtLogin: true }); registerIpc(); window = createWindow(); createTray(); await startMonitor().catch(() => { monitorStatus = "offline"; window?.webContents.send("sync.status", monitorStatus); }); app.on("activate", showWindow); }).catch((error) => console.error(error));
}
app.on("before-quit", (event) => { if (quitting) return; event.preventDefault(); quitting = true; void monitor?.stop().finally(() => app.quit()); });
app.on("window-all-closed", () => undefined);
