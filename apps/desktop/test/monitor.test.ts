import { readFile, appendFile, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { IngestEvent, TaskSnapshot } from "@codex-assistant/protocol";
import { Monitor, ACTIVE_EVIDENCE_MAX_AGE_MS, IN_PROGRESS_ITEM_MAX_AGE_MS } from "../src/monitor.js";
import type { AppServerNotification } from "../src/app-server.js";

const mock = vi.hoisted(() => ({ path: "", reads: 0, activeItem: true, revision: 0, failResume: false, activeWriter: false, notify: undefined as ((value: AppServerNotification) => void) | undefined }));
vi.mock("../src/app-server.js", () => ({
  CodexAppServer: class {
    constructor(options: { onNotification: (value: AppServerNotification) => void }) { mock.notify = options.onNotification; }
    get ready() { return true; }
    async resumeThread() { if (mock.failResume) throw new Error("RESUME_FAILED"); if (mock.activeWriter) throw new Error("thread already has an active writer"); }
    async recoverActiveTurn() { return mock.activeWriter ? { id: "turn-1", status: "inProgress" } : undefined; }
    ownsTurn(_threadId: string, _turnId: string) { return mock.activeWriter; }
    async startTurn() {}
    async steerTurn(_threadId: string, turnId: string) { return { turn: { id: turnId, status: "inProgress" } }; }
    async start() {} async stop() {} setTraceContext() {}
    async listThreads() { return [{ id: "thread", path: mock.path, status: { type: "notLoaded" }, updatedAt: "2026-09-08T06:00:00Z" }]; }
    async readThread() { mock.reads++; return {}; }
    async getGoal() { return undefined; }
    async listTurns() { return { data: [{ status: "interrupted" }] }; }
    async listItems() { return { data: mock.activeItem ? [{ turnId: "turn-1", item: { type: "commandExecution", status: "inProgress" } }] : [] }; }
    latestTurn() { return undefined; } planFor() { return undefined; } planRevision() { return mock.revision; }
  },
}));

it("releases failed resume and local IPC terminal locks without a cloud control socket", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-send-"));
  const monitor = await Monitor.create({ stateDirectory: directory, apiUrl: "https://monitor.invalid", token: "test", deviceId: "test-device", onTasks: () => {} });
  try {
    mock.failResume = true;
    await expect(monitor.sendMessage("thread", "first")).rejects.toThrow("RESUME_FAILED");
    mock.failResume = false;
    await expect(monitor.sendMessage("thread", "retry")).resolves.toEqual({ status: "started" });
    mock.notify?.({ method: "item/completed", params: { threadId: "thread" } });
    await expect(monitor.sendMessage("thread", "duplicate")).resolves.toMatchObject({status: "started"});
    mock.notify?.({ method: "turn/completed", params: { threadId: "thread" } });
    await expect(monitor.sendMessage("thread", "next turn")).resolves.toEqual({ status: "started" });
  } finally { mock.failResume = false; await monitor.stop(); await rm(directory, { recursive: true, force: true }); }
});

it("recovers the local active turn when resume races its writer notification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-active-writer-recovery-"));
  const monitor = await Monitor.create({ stateDirectory: directory, apiUrl: "https://monitor.invalid", token: "test", deviceId: "test-device", onTasks: () => {} });
  try {
    mock.activeWriter = true;
    await expect(monitor.sendMessage("thread", "recover local turn")).resolves.toMatchObject({ status: "started", turnId: "turn-1" });
  } finally { mock.activeWriter = false; await monitor.stop(); await rm(directory, { recursive: true, force: true }); }
});

it("preserves a concatenated outbox JSON file and refuses to reset its sequence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-outbox-corrupt-"));
  try {
    await writeFile(join(directory, "outbox.json"), '{"deviceId":"test-device"}\n{"deviceId":"test-device"}\n');
    await expect(Monitor.create({ stateDirectory: directory, apiUrl: "https://monitor.invalid", token: "test", deviceId: "test-device", onTasks: () => {} })).rejects.toThrow("OUTBOX_INVALID");
    expect(await readFile(join(directory, "outbox.json"), "utf8")).toBe('{"deviceId":"test-device"}\n{"deviceId":"test-device"}\n');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

it("reprojects unchanged metadata, expires cached evidence on read failure, and uploads recovery and completion", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-monitor-"));
  mock.path = join(directory, "rollout.jsonl");
  mock.reads = 0;
  mock.activeItem = true;
  mock.revision = 0;
  let now = Date.parse("2026-09-08T06:00:00Z");
  const event = (type: string) => JSON.stringify({ type: "event_msg", timestamp: new Date(now).toISOString(), payload: { type, turn_id: "turn-1" } }) + "\n";
  const uploaded: IngestEvent[] = [];
  const snapshots: TaskSnapshot[] = [];
  let nextPoll: (() => void) | undefined;
  const waitForPoll = () => new Promise<void>(resolve => { nextPoll = resolve; });
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/events")) uploaded.push(JSON.parse(String(init.body)) as IngestEvent);
    return { ok: true, status: 200 };
  }));
  let monitor: Monitor | undefined;
  try {
    await writeFile(mock.path, event("task_started"));
    await utimes(mock.path, now / 1000, now / 1000);
    monitor = await Monitor.create({ stateDirectory: directory, apiUrl: "https://monitor.invalid", token: "test", deviceId: "test-device",
      onTasks: tasks => snapshots.push(tasks[0]), onStatus: status => { if (status === "connected") { nextPoll?.(); nextPoll = undefined; } } });
    await monitor.start();
    expect(snapshots.at(-1)).toMatchObject({ status: "running", freshness: "fresh" });

    now += ACTIVE_EVIDENCE_MAX_AGE_MS;
    await waitForPoll();
    expect(snapshots.at(-1)).toMatchObject({ status: "running", freshness: "stale" });

    now += IN_PROGRESS_ITEM_MAX_AGE_MS - ACTIVE_EVIDENCE_MAX_AGE_MS;
    await waitForPoll();
    expect(snapshots.at(-1)).toMatchObject({ status: "needs_action", freshness: "stale", error: { code: "ACTIVE_EVIDENCE_EXPIRED" } });

    mock.activeItem = false;
    mock.revision++;
    await appendFile(mock.path, JSON.stringify({ type: "event_msg", timestamp: new Date(now).toISOString(), payload: { type: "token_count" } }) + "\n");
    await utimes(mock.path, now / 1000, now / 1000);
    await waitForPoll();
    expect(snapshots.at(-1)).toMatchObject({ status: "running", freshness: "fresh" });

    await rename(mock.path, mock.path + ".held");
    now += ACTIVE_EVIDENCE_MAX_AGE_MS;
    await waitForPoll();
    expect(snapshots.at(-1)).toMatchObject({ status: "needs_action", freshness: "stale", error: { code: "ACTIVE_EVIDENCE_EXPIRED" } });

    await rename(mock.path + ".held", mock.path);
    await appendFile(mock.path, event("task_complete"));
    await waitForPoll();
    expect(snapshots.at(-1)).toMatchObject({ status: "completed", freshness: "fresh" });
    expect(mock.reads).toBe(2); // 状态投影按证据时间重算；只有计划修订时重新读取详情。
    expect(uploaded.map(row => row.task.status)).toEqual(["running", "running", "needs_action", "running", "needs_action", "completed"]);
    expect(uploaded.map(row => row.localSequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(JSON.stringify(uploaded)).not.toContain("evidenceAt");
  } finally {
    await monitor?.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);


it("waits for an in-flight upload before shutting down and persisting the queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-stop-"));
  let release!: () => void;
  let entered!: () => void;
  const enteredUpload = new Promise<void>(resolve => { entered = resolve; });
  const upload = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/events")) { entered(); await upload; }
    return { ok: true, status: 200 };
  }));
  mock.path = join(directory, "absent.jsonl");
  const monitor = await Monitor.create({ stateDirectory: directory, apiUrl: "https://monitor.invalid", token: "test", deviceId: "test-device", onTasks() {} });
  try {
    const starting = monitor.start();
    await enteredUpload;
    let stopped = false;
    const stopping = monitor.stop().then(() => { stopped = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(stopped).toBe(false);
    release(); await starting; await stopping;
    expect(JSON.parse(await readFile(join(directory, "outbox.json"), "utf8")).events).toHaveLength(0);
    await expect(monitor.sendMessage("thread", "after stop")).rejects.toThrow("MONITOR_STOPPED");
  } finally { release(); await monitor.stop(); vi.unstubAllGlobals(); await rm(directory, { recursive: true, force: true }); }
});
