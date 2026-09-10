import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => void>(), quit: vi.fn() }));
vi.mock('electron', () => ({
  app: { requestSingleInstanceLock: () => true, on: (name: string, callback: (...args: any[]) => void) => state.handlers.set(name, callback), whenReady: () => new Promise(() => {}), quit: state.quit },
  BrowserWindow: class {}, ipcMain: {}, Menu: {}, nativeImage: {}, shell: {}, Tray: class {}, safeStorage: {},
}));

it('can quit before a monitor exists, including an unconfigured or failed startup', async () => {
  await import('../src/main.js');
  const preventDefault = vi.fn();
  state.handlers.get('before-quit')!({ preventDefault });
  await vi.waitFor(() => expect(state.quit).toHaveBeenCalledOnce());
  expect(preventDefault).toHaveBeenCalledOnce();
});
