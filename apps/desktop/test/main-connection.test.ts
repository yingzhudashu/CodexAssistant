import { expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  ipc: new Map<string, (...args: any[]) => any>(),
  events: new Map<string, (...args: any[]) => any>(),
  window: undefined as any,
  monitors: [] as any[],
  save: vi.fn(),
}));
vi.mock("electron", () => ({
  app: {
    requestSingleInstanceLock: () => true,
    whenReady: async () => {},
    on: (name: string, fn: any) => fixture.events.set(name, fn),
    getPath: () => "synthetic-user-data",
    setAppUserModelId() {},
    setLoginItemSettings() {},
    quit() {},
  },
  BrowserWindow: class {
    webContents = { send: vi.fn(), on() {}, setWindowOpenHandler() {} };
    constructor() {
      fixture.window = this;
    }
    async loadFile() {}
    on() {}
    once() {}
    show() {}
    isDestroyed() {
      return false;
    }
  },
  ipcMain: { handle: (name: string, fn: any) => fixture.ipc.set(name, fn) },
  Menu: { buildFromTemplate: (value: unknown) => value },
  nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
  Tray: class {
    setToolTip() {}
    setContextMenu() {}
    on() {}
  },
  shell: {},
}));
vi.mock("../src/desktop-config.js", () => ({
  loadDesktopConnection: async () => ({
    configured: true,
    apiUrl: "https://example.test",
    token: "synthetic-token-1234",
    deviceId: "synthetic",
  }),
  saveDesktopConnection: fixture.save,
}));
vi.mock("../src/monitor.js", () => ({
  Monitor: {
    create: async (options: any) => {
      let rejectStart: (error: Error) => void = () => {};
      const instance = {
        options,
        stop: vi.fn(async () => {}),
        start: vi.fn(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectStart = reject;
            }),
        ),
        failStart: () => rejectStart(new Error("HANDSHAKE_FAILED")),
      };
      fixture.monitors.push(instance);
      return instance;
    },
  },
}));

it("keeps a valid monitor on save failure, serializes saves, and ignores replaced startup callbacks", async () => {
  await import("../src/main.js");
  await vi.waitFor(() => expect(fixture.monitors).toHaveLength(1));
  const event = {
    sender: fixture.window.webContents,
    senderFrame: {
      url: new URL("../src/renderer/index.html", import.meta.url).href,
    },
  };
  const save = fixture.ipc.get("connection.save")!;
  fixture.save.mockRejectedValueOnce(new Error("STORAGE_FAILED"));
  await expect(
    save(event, {
      apiUrl: "https://example.test",
      token: "synthetic-token-1234",
    }),
  ).rejects.toThrow("STORAGE_FAILED");
  expect(fixture.monitors[0].stop).not.toHaveBeenCalled();

  let resolveSave!: (value: unknown) => void;
  fixture.save.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        resolveSave = resolve;
      }),
  );
  const saving = save(event, {
    apiUrl: "https://new.example.test",
    token: "synthetic-new-token",
  });
  await expect(
    save(event, {
      apiUrl: "https://new.example.test",
      token: "synthetic-new-token",
    }),
  ).rejects.toThrow("CONNECTION_SAVE_IN_PROGRESS");
  resolveSave({
    configured: true,
    apiUrl: "https://new.example.test",
    deviceId: "synthetic",
  });
  await expect(saving).resolves.toMatchObject({ configured: true });
  await vi.waitFor(() => expect(fixture.monitors).toHaveLength(2));
  expect(fixture.monitors[0].stop).toHaveBeenCalledOnce();
  fixture.monitors[1].options.onStatus("connected");
  fixture.monitors[0].options.onStatus("offline");
  fixture.monitors[0].failStart();
  await Promise.resolve();
  await Promise.resolve();
  expect(fixture.ipc.get("sync.status")!(event)).toBe("connected");
  expect(() =>
    fixture.ipc.get("tasks.get")!({
      ...event,
      senderFrame: { url: "https://example.test" },
    }),
  ).toThrow("DESKTOP_IPC_SENDER_DENIED");
});
