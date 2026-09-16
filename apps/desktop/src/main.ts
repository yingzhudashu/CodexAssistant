import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  shell,
  Tray,
} from "electron";
import {
  loadDesktopConnection,
  saveDesktopConnection,
} from "./desktop-config.js";
import { isNewerVersion } from "./updates.js";
import { Monitor, type MonitorStatus } from "./monitor.js";
import type { TaskSnapshot } from "@codex-assistant/protocol";

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let monitor: Monitor | undefined;
let latestTasks: TaskSnapshot[] = [];
let monitorStatus: MonitorStatus = "connecting";
let quitting = false;
let monitorGeneration = 0;
let savingConnection = false;

function assertTrustedSender(event: Electron.IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url;
  if (
    event.sender !== window?.webContents ||
    url !==
      pathToFileURL(join(import.meta.dirname, "renderer", "index.html")).href
  )
    throw new Error("DESKTOP_IPC_SENDER_DENIED");
}
function createWindow(): BrowserWindow {
  // 首次打开使用完整工作台尺寸，同时保留430px紧凑监控窗口。
  const next = new BrowserWindow({
    icon: join(import.meta.dirname, "assets", "tray.ico"),
    width: 1100,
    height: 760,
    minWidth: 430,
    minHeight: 600,
    show: false,
    resizable: true,
    webPreferences: {
      preload: join(import.meta.dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  void next
    .loadFile(join(import.meta.dirname, "renderer", "index.html"))
    .catch((error: unknown) => {
      console.error("CodexAssistant renderer load failed", error);
      if (!next.isDestroyed()) next.show();
    });
  // 工作台固定加载打包页面，正文链接和嵌入内容不能把特权窗口导航到其他来源。
  next.webContents.on("will-navigate", (event) => event.preventDefault());
  next.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  next.webContents.on("render-process-gone", (_event, details) =>
    console.error("CodexAssistant renderer exited", details.reason),
  );
  next.webContents.on("did-fail-load", (_event, code, description) =>
    console.error(
      "CodexAssistant renderer navigation failed",
      code,
      description,
    ),
  );
  next.once("ready-to-show", () => next.show());
  next.on("closed", () => {
    window = undefined;
  });
  return next;
}
function showWindow(): void {
  if (!window || window.isDestroyed()) window = createWindow();
  else if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}
function createTray(): void {
  const image = nativeImage.createFromPath(
    join(import.meta.dirname, "assets", "tray.ico"),
  );
  if (image.isEmpty()) throw new Error("TRAY_ICON_INVALID");
  tray = new Tray(image);
  tray.setToolTip("CodexAssistant");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开 CodexAssistant", click: showWindow },
      { label: "退出", click: () => app.quit() },
    ]),
  );
  tray.on("double-click", showWindow);
}
async function startMonitor(): Promise<void> {
  const generation = ++monitorGeneration;
  try {
    const connection = await loadDesktopConnection();
    if (
      !connection.configured ||
      !connection.apiUrl ||
      !connection.token ||
      !connection.deviceId
    )
      return;
    if (generation !== monitorGeneration || quitting) return;
    const stateDirectory = join(app.getPath("userData"), "state");
    const next = await Monitor.create({
      stateDirectory,
      apiUrl: connection.apiUrl,
      token: connection.token,
      deviceId: connection.deviceId,
      onTasks: (tasks) => {
        if (generation !== monitorGeneration || quitting) return;
        latestTasks = tasks;
        window?.webContents.send("tasks.updated", tasks);
      },
      onStatus: (status) => {
        if (generation !== monitorGeneration || quitting) return;
        monitorStatus = status;
        window?.webContents.send("sync.status", status);
      },
    });
    if (generation !== monitorGeneration || quitting) {
      await next.stop();
      return;
    }
    monitor = next;
    await next.start();
  } catch {
    if (generation === monitorGeneration && !quitting) {
      monitorStatus = "offline";
      window?.webContents.send("sync.status", monitorStatus);
    }
  }
}
function registerIpc(): void {
  ipcMain.handle("connection.get", async (event) => {
    assertTrustedSender(event);
    const value = await loadDesktopConnection();
    return {
      configured: value.configured,
      apiUrl: value.apiUrl,
      deviceId: value.deviceId,
    };
  });
  ipcMain.handle("connection.save", async (event, input: unknown) => {
    assertTrustedSender(event);
    if (!input || typeof input !== "object")
      throw new Error("DESKTOP_CONNECTION_INVALID");
    const value = input as Record<string, unknown>;
    if (typeof value.apiUrl !== "string" || typeof value.token !== "string")
      throw new Error("DESKTOP_CONNECTION_INVALID");
    if (savingConnection) throw new Error("CONNECTION_SAVE_IN_PROGRESS");
    savingConnection = true;
    try {
      // 先验证并原子保存；输入错误或安全存储失败不得关闭仍有效的旧连接。
      const saved = await saveDesktopConnection({
        apiUrl: value.apiUrl,
        token: value.token,
      });
      monitorGeneration++;
      await monitor?.stop();
      monitor = undefined;
      latestTasks = [];
      monitorStatus = "connecting";
      window?.webContents.send("tasks.updated", latestTasks);
      window?.webContents.send("sync.status", monitorStatus);
      // 保存只确认本地持久化；握手失败由状态展示，不能把已保存配置误报为保存失败。
      void startMonitor();
      return {
        configured: saved.configured,
        apiUrl: saved.apiUrl,
        deviceId: saved.deviceId,
      };
    } finally {
      savingConnection = false;
    }
  });
  ipcMain.handle("task.detail", async (event, input: unknown) => {
    assertTrustedSender(event);
    if (
      !monitor ||
      !input ||
      typeof input !== "object" ||
      typeof (input as { threadId?: unknown }).threadId !== "string"
    )
      throw new Error("TASK_INVALID");
    return monitor.readDetail(
      (input as { threadId: string }).threadId,
      typeof (input as { cursor?: unknown }).cursor === "string"
        ? (input as { cursor: string }).cursor
        : undefined,
    );
  });
  ipcMain.handle("task.send", async (event, input: unknown) => {
    assertTrustedSender(event);
    if (!monitor || !input || typeof input !== "object")
      throw new Error("MESSAGE_INVALID");
    const value = input as Record<string, unknown>;
    if (typeof value.threadId !== "string" || typeof value.text !== "string")
      throw new Error("MESSAGE_INVALID");
    return monitor.sendMessage(value.threadId, value.text);
  });
  ipcMain.handle("update.check", async (event) => {
    assertTrustedSender(event);
    const connection = await loadDesktopConnection();
    if (!connection.apiUrl) throw new Error("DESKTOP_NOT_CONFIGURED");
    const response = await fetch(
      `${connection.apiUrl}/codex-assistant/downloads/manifest.json`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!response.ok) throw new Error("UPDATE_CHECK_FAILED");
    const manifest = (await response.json()) as {
      version?: unknown;
      downloads?: { windows?: { url?: unknown }; android?: { url?: unknown } };
    };
    const version =
      typeof manifest.version === "string" ? manifest.version : "";
    return {
      currentVersion: app.getVersion(),
      latestVersion: version,
      available: isNewerVersion(version, app.getVersion()),
      windowsUrl:
        typeof manifest.downloads?.windows?.url === "string"
          ? manifest.downloads.windows.url
          : undefined,
      androidUrl:
        typeof manifest.downloads?.android?.url === "string"
          ? manifest.downloads.android.url
          : undefined,
    };
  });
  ipcMain.handle("update.download", async (event, target: unknown) => {
    assertTrustedSender(event);
    if (target !== "windows" && target !== "android")
      throw new Error("UPDATE_TARGET_INVALID");
    const connection = await loadDesktopConnection();
    if (!connection.apiUrl) throw new Error("DESKTOP_NOT_CONFIGURED");
    const response = await fetch(
      `${connection.apiUrl}/codex-assistant/downloads/manifest.json`,
      { signal: AbortSignal.timeout(8_000) },
    );
    if (!response.ok) throw new Error("UPDATE_CHECK_FAILED");
    const manifest = (await response.json()) as {
      downloads?: Record<string, { url?: unknown }>;
    };
    const url = manifest.downloads?.[target]?.url;
    if (typeof url !== "string" || !/^https:\/\//i.test(url))
      throw new Error("UPDATE_URL_INVALID");
    await shell.openExternal(url);
    return { opened: true };
  });
  ipcMain.handle("interactions.get", (event) => {
    assertTrustedSender(event);
    return monitor?.interactions ?? [];
  });
  ipcMain.handle("interaction.submit", (event, input: unknown) => {
    assertTrustedSender(event);
    const v = input as Record<string, unknown>;
    if (
      !monitor ||
      !v ||
      typeof v.requestId !== "string" ||
      typeof v.threadId !== "string"
    )
      throw new Error("INTERACTION_INVALID");
    return monitor.submitInteraction(v.requestId, v.threadId, v.value);
  });
  ipcMain.handle("tasks.get", (event) => {
    assertTrustedSender(event);
    return latestTasks;
  });
  ipcMain.handle("sync.status", (event) => {
    assertTrustedSender(event);
    return monitorStatus;
  });
  ipcMain.handle("workstation.status", (event) => {
    assertTrustedSender(event);
    return { ready: monitor?.workstationReady === true };
  });
}
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on("second-instance", showWindow);
  app
    .whenReady()
    .then(async () => {
      app.setAppUserModelId("site.codexassistant");
      app.setLoginItemSettings({ openAtLogin: true });
      registerIpc();
      window = createWindow();
      createTray();
      await startMonitor();
      app.on("activate", showWindow);
    })
    .catch((error) => console.error(error));
}
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  void (monitor?.stop() ?? Promise.resolve())
    .catch(() => console.error("Monitor shutdown failed"))
    .finally(() => app.quit());
});
app.on("window-all-closed", () => undefined);
