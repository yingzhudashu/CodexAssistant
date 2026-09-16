import { readFile } from "node:fs/promises";
import { createContext, runInContext } from "node:vm";
import { expect, it, vi } from "vitest";
import { TaskStatusSchema } from "@codex-assistant/protocol";

it("allows local sending during cloud sync/offline and preserves a draft while the workstation is not ready", async () => {
  const handlers = new Map<string, (event: unknown) => Promise<void>>();
  let ready = true;
  let syncListener: (status: string) => Promise<void> = async () => {};
  const send = vi.fn(async () => ({ status: "started" }));
  const root = {
    innerHTML: "",
    querySelectorAll: (selector: string) => selector === "#message-form" ? [{ addEventListener: (_: string, handler: (event: unknown) => Promise<void>) => handlers.set("send", handler) }] : [],
    insertAdjacentHTML: () => {},
  };
  const context = createContext({
    document: { querySelector: () => root, documentElement: { dataset: {} }, activeElement: null, addEventListener: () => {} },
    HTMLInputElement: class {}, HTMLTextAreaElement: class {},
    localStorage: { getItem: () => null }, matchMedia: () => ({ matches: false, addEventListener: () => {} }),
    window: { addEventListener: () => {}, interactionForms: {render: () => "", bind: () => {}}, codexAssistant: {
      getInteractions: async () => [], getConnection: async () => ({ configured: true }), getTasks: async () => [{ id: "task", title: "任务", status: "running", freshness: "fresh", plan: [] }],
      getSyncStatus: async () => "syncing", getWorkstationStatus: async () => ({ ready }),
      onTasks: () => {}, onSyncStatus: (fn: typeof syncListener) => { syncListener = fn; }, sendTaskMessage: send,
    } },
  });
  runInContext(await readFile(new URL("../src/renderer/workspace.js", import.meta.url), "utf8"), context);
  await vi.waitFor(() => expect(root.innerHTML).toContain("任务工作台"));
  runInContext("s.selected='task';s.tab='message';s.draft.set('task','继续');render()", context);
  for (const cloudStatus of ["syncing", "offline"]) {
    await syncListener(cloudStatus);
    expect(root.innerHTML).not.toContain('id="send" class="primary" disabled');
    expect(root.innerHTML).not.toContain("本机 Codex 服务尚未就绪");
  }
  ready = false;
  await syncListener("connected");
  expect(root.innerHTML).toContain('id="send" class="primary" disabled');
  await handlers.get("send")?.({ preventDefault() {} });
  expect(send).not.toHaveBeenCalled();
  expect(runInContext("s.draft.get('task')", context)).toBe("继续");
  ready = true;
  await syncListener("syncing");
  await handlers.get("send")?.({ preventDefault() {} });
  expect(send).toHaveBeenCalledExactlyOnceWith({ threadId: "task", text: "继续" });
  expect(runInContext("s.draft.has('task')", context)).toBe(false);
});

it("keeps Windows and Android task filter names and order identical to the four-state protocol", async () => {
  const desktop = await readFile(new URL("../src/renderer/workspace.js", import.meta.url), "utf8");
  const labels = runInContext(`(${desktop.match(/const labels = ({[\s\S]*?});/)![1]})`, createContext());
  expect(Object.keys(labels).sort()).toEqual(TaskStatusSchema.anyOf.map(status => status.const).sort());
  const android = await readFile(new URL("../../../android/app/src/main/java/site/codexassistant/TaskPresentation.kt", import.meta.url), "utf8");
  const filters = [...android.match(/val taskStatusFilters\s*=\s*listOf\(([\s\S]*?)\n\s*\)/)![1].matchAll(/"([a-z_]+)" to "([^"]+)"/g)].map(row => [row[1], row[2]]);
  expect(filters).toEqual([["all", "全部"], ...Object.entries(labels)]);
});
