import { readFile, appendFile, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { IngestEvent, TaskSnapshot } from "@codex-assistant/protocol";
import { Monitor, DESKTOP_HOST_UNAVAILABLE_MESSAGE, ACTIVE_EVIDENCE_MAX_AGE_MS, IN_PROGRESS_ITEM_MAX_AGE_MS } from "../src/monitor.js";
import type { AppServerNotification } from "../src/app-server.js";

const mock = vi.hoisted(() => ({ path: "", reads: 0, itemReads: 0, goalReads: 0, goalFails: false, activeItem: true, itemTurnId: "turn-1", revision: 0, threads: undefined as Array<{ id: string; path?: string; updatedAt: string; status: { type: string } }> | undefined, notify: undefined as ((value: AppServerNotification) => void) | undefined }));
vi.mock("../src/app-server.js", () => ({
  CodexAppServer: class {
    constructor(options: { onNotification: (value: AppServerNotification) => void }) { mock.notify = options.onNotification; }
    get ready() { return true; }
    async start() {} async stop() {} setTraceContext() {}
    async listThreads() { return mock.threads ?? [{ id: "thread", path: mock.path, status: { type: "notLoaded" }, updatedAt: "2026-09-08T06:00:00Z" }]; }
    async readThread() { mock.reads++; return {}; }
    async getGoal() { mock.goalReads++; if (mock.goalFails) throw new Error("synthetic goal read failure"); return undefined; }
    async listTurns() { return { data: [{ status: "interrupted" }] }; }
    async listItems() { mock.itemReads++; return { data: mock.activeItem ? [{ turnId: mock.itemTurnId, item: { type: "commandExecution", status: "inProgress" } }] : [] }; }
    latestTurn() { return undefined; } planFor() { return undefined; } planRevision() { return mock.revision; }
  },
}));

it("releases failed Desktop dispatches without leaking IPC errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-send-"));
  const sent: string[] = [];
  let failure: Error | undefined = new Error("CODEX_DESKTOP_HOST_UNAVAILABLE");
  const desktopHost = { sendMessage: vi.fn(async (_threadId: string, text: string) => { sent.push(text); if (failure) throw failure; }) };
  const monitor = await Monitor.create({ stateDirectory: directory, apiUrl: "https://monitor.invalid", token: "test", deviceId: "test-device", onTasks: () => {}, desktopHost });
  try {
    await expect(monitor.sendMessage("thread", "first")).rejects.toThrow(DESKTOP_HOST_UNAVAILABLE_MESSAGE);
    failure = undefined;
    await expect(monitor.sendMessage("thread", "retry")).resolves.toEqual({ status: "started" });
    expect(sent).toEqual(["first", "retry"]);
  } finally { await monitor.stop(); await rm(directory, { recursive: true, force: true }); }
});

it("serializes overlapping sends within a thread while another thread continues", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-send-parallel-"));
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const desktopHost = { sendMessage: async (_thread: string, text: string) => { calls.push(text); if (text === "first") await gate; }, close: vi.fn() };
  const monitor = await Monitor.create({ stateDirectory: directory, apiUrl: "https://monitor.invalid", token: "test", deviceId: "test-device", onTasks() {}, desktopHost });
  try {
    const first = monitor.sendMessage("thread", "first");
    const second = monitor.sendMessage("thread", "second");
    await monitor.sendMessage("other", "independent");
    expect(calls).toEqual(["first", "independent"]);
    release(); await Promise.all([first, second]);
    expect(calls).toEqual(["first", "independent", "second"]);
  } finally { release(); await monitor.stop(); expect(desktopHost.close).toHaveBeenCalledOnce(); await rm(directory, { recursive: true, force: true }); }
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
    return { ok: true, status: 200, json: async () => ({ accepted: true, duplicate: false, sequence: Math.max(1, uploaded.length) }) };
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
    expect(mock.reads).toBe(3); // 元数据修订或生命周期回合变化时重读；单纯重新投影不重复读取详情。
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

it("refreshes cached operation evidence when a historical thread starts a new rollout turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-monitor-old-thread-"));
  const base = Date.parse("2026-09-08T06:00:00Z");
  mock.path = join(directory, "rollout.jsonl");
  mock.reads = 0;
  mock.itemReads = 0;
  mock.itemTurnId = "turn-1";
  mock.activeItem = false;
  mock.revision = 0;
  let now = base;
  const oldCompletion = JSON.stringify({ type: "event_msg", timestamp: new Date(base).toISOString(), payload: { type: "task_complete", turn_id: "turn-1" } }) + "\n";
  const newStart = JSON.stringify({ type: "event_msg", timestamp: new Date(base + 1_000).toISOString(), payload: { type: "task_started", turn_id: "turn-2" } }) + "\n";
  const snapshots: TaskSnapshot[] = [];
  let nextPoll: (() => void) | undefined;
  const waitForPoll = () => new Promise<void>(resolve => { nextPoll = resolve; });
  vi.spyOn(Date, "now").mockImplementation(() => now);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ accepted: true, duplicate: false, sequence: 1 }) })));
  let monitor: Monitor | undefined;
  try {
    await writeFile(mock.path, oldCompletion);
    await utimes(mock.path, base / 1000, base / 1000);
    monitor = await Monitor.create({ stateDirectory: directory, apiUrl: "https://monitor.invalid", token: "test", deviceId: "test-device",
      onTasks: tasks => snapshots.push(tasks[0]), onStatus: status => { if (status === "connected") { nextPoll?.(); nextPoll = undefined; } } });
    await monitor.start();
    expect(snapshots.at(-1)).toMatchObject({ status: "completed", freshness: "fresh" });
    expect(mock.itemReads).toBe(1);

    now = base + 4 * 60 * 60_000;
    mock.itemTurnId = "turn-2";
    mock.activeItem = true;
    await appendFile(mock.path, newStart);
    await utimes(mock.path, (base + 1_000) / 1000, (base + 1_000) / 1000);
    await waitForPoll();

    expect(mock.itemReads).toBe(2);
    expect(snapshots.at(-1)).toMatchObject({ status: "running", freshness: "stale", latestTurn: { status: "inProgress" } });
  } finally {
    await monitor?.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mock.threads = undefined;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

it("keeps normalizing fresh app-server details while a cold rollout scan catches up", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-monitor-catchup-"));
  mock.path = join(directory, "rollout.jsonl");
  mock.reads = 0;
  mock.itemReads = 0;
  mock.activeItem = false;
  mock.revision = 0;
  mock.threads = [{ id: "catchup-thread", path: mock.path, updatedAt: "2026-09-08T06:00:00Z", status: { type: "notLoaded" } }];
  vi.stubGlobal("fetch", vi.fn(async (url: string) => url.endsWith("/traces/spans")
    ? { ok: true, status: 200, json: async () => ({ accepted: true }) }
    : { ok: true, status: 200, json: async () => ({ accepted: true, duplicate: false, sequence: 1 }) }));
  let monitor: Monitor | undefined;
  let snapshot: TaskSnapshot | undefined;
  try {
    await writeFile(mock.path, JSON.stringify({ type: "event_msg", timestamp: "2026-09-08T06:00:00Z", payload: { type: "task_complete", turn_id: "catchup-turn" } }) + "\n" + ("{\"type\":\"response_item\",\"text\":\"padding\"}\n".repeat(70_000)));
    monitor = await Monitor.create({ stateDirectory: directory, apiUrl: "https://monitor.invalid", token: "test", deviceId: "test-device", onTasks: tasks => { snapshot = tasks[0]; } });
    await monitor.start();
    expect(snapshot).toMatchObject({ id: "catchup-thread", status: "needs_action", freshness: "fresh" });
    expect(snapshot?.error).toBeUndefined();
    await monitor.stop();
    const spans = (await readFile(join(directory, "outbox.json.trace.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(spans).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "desktop.poll", attributes: expect.objectContaining({ lifecycleReadFailures: "1", lifecycleCatchups: "1", lifecyclePathMissing: "0", lifecycleEvidenceMissing: "0", detailFailures: "0" }) }),
    ]));
  } finally {
    await monitor?.stop();
    vi.unstubAllGlobals();
    mock.threads = undefined;
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

it("keeps available thread data visible and retries only the failed detail source", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-monitor-partial-detail-"));
  mock.path = join(directory, "rollout.jsonl");
  mock.reads = 0;
  mock.itemReads = 0;
  mock.goalReads = 0;
  mock.goalFails = true;
  mock.activeItem = false;
  mock.revision = 0;
  mock.threads = [{ id: "partial-thread", updatedAt: "2026-09-08T06:00:00Z", status: { type: "idle" } }];
  const snapshots: TaskSnapshot[] = [];
  let nextPoll: (() => void) | undefined;
  const waitForPoll = () => new Promise<void>(resolve => { nextPoll = resolve; });
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ accepted: true, duplicate: false, sequence: 1 }) })));
  let monitor: Monitor | undefined;
  try {
    monitor = await Monitor.create({ stateDirectory: directory, apiUrl: "https://monitor.invalid", token: "test", deviceId: "test-device",
      onTasks: tasks => snapshots.push(tasks[0]), onStatus: status => { if (status === "connected") { nextPoll?.(); nextPoll = undefined; } } });
    await monitor.start();
    expect(snapshots.at(-1)).toMatchObject({ id: "partial-thread", status: "needs_action", freshness: "stale", error: { code: "DETAIL_UNAVAILABLE" } });
    expect(mock.goalReads).toBe(1);
    expect(mock.itemReads).toBe(1);

    mock.goalFails = false;
    await waitForPoll();
    expect(snapshots.at(-1)).toMatchObject({ id: "partial-thread", status: "needs_action", freshness: "fresh" });
    expect(snapshots.at(-1)?.error).toBeUndefined();
    expect(mock.goalReads).toBe(2);
    expect(mock.itemReads).toBe(1);
  } finally {
    await monitor?.stop();
    vi.unstubAllGlobals();
    mock.threads = undefined;
    mock.goalFails = false;
    await rm(directory, { recursive: true, force: true });
  }
}, 10_000);


it("waits for an in-flight upload before shutting down and persisting the queue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-stop-"));
  let release!: () => void;
  let entered!: () => void;
  const enteredUpload = new Promise<void>(resolve => { entered = resolve; });
  const upload = new Promise<void>(resolve => { release = resolve; });
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    if (url.endsWith("/events")) { entered(); await upload; }
    return { ok: true, status: 200, json: async () => ({ accepted: true, duplicate: false, sequence: 1 }) };
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


it("uses the recorded upload span as the W3C HTTP parent within the poll trace", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-trace-chain-"));
  mock.threads = [{ id: "trace-thread", updatedAt: "2026-09-08T06:00:00Z", status: { type: "idle" } }];
  let event: IngestEvent | undefined;
  let header = "";
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/events")) {
      event = JSON.parse(String(init.body));
      header = String((init.headers as Record<string,string>).traceparent);
    }
    return { ok: true, status: 200, json: async () => ({accepted:true,duplicate:false,sequence:1}) };
  }));
  let monitor: Monitor | undefined;
  try {
    monitor = await Monitor.create({ stateDirectory: directory, apiUrl: "https://trace.invalid", token: "synthetic", deviceId: "trace-device", onTasks() {} });
    await monitor.start();
    await monitor.stop();
    const spans = (await readFile(join(directory,"outbox.json.trace.jsonl"),"utf8")).trim().split("\n").map(line=>JSON.parse(line));
    const poll = spans.find(span=>span.name==="desktop.poll");
    const upload = spans.find(span=>span.name==="desktop.upload");
    expect(event!.trace.traceId).toBe(poll.traceId);
    expect(event!.trace.parentSpanId).toBe(poll.spanId);
    expect(upload.parentSpanId).toBe(event!.trace.spanId);
    expect(header).toBe(`00-${poll.traceId}-${upload.spanId}-01`);
  } finally {
    await monitor?.stop(); mock.threads=undefined; vi.unstubAllGlobals();
    await rm(directory,{recursive:true,force:true});
  }
});

it("records trace upload response failures without failing the poll", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-trace-upload-failure-"));
  mock.threads = [{ id: "trace-thread", updatedAt: "2026-09-08T06:00:00Z", status: { type: "idle" } }];
  vi.stubGlobal("fetch", vi.fn(async (url: string) =>
    url.endsWith("/traces/spans")
      ? { ok: false, status: 503 }
      : { ok: true, status: 200, json: async () => ({ accepted: true, duplicate: false, sequence: 1 }) },
  ));
  let monitor: Monitor | undefined;
  try {
    monitor = await Monitor.create({ stateDirectory: directory, apiUrl: "https://trace.invalid", token: "synthetic", deviceId: "trace-device", onTasks() {} });
    await monitor.start();
    await monitor.stop();
    const spans = (await readFile(join(directory, "outbox.json.trace.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    expect(spans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        name: "desktop.trace_upload.error",
        attributes: expect.objectContaining({ phase: "response", status: "503", error: "TRACE_HTTP_FAILED" }),
      }),
    ]));
  } finally {
    await monitor?.stop();
    mock.threads = undefined;
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
});

it("polls 150 threads, uploads all business events in bounded batches, and reports trace evictions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-monitor-load-"));
  mock.threads = Array.from({ length: 150 }, (_, index) => ({ id: `load-thread-${index}`, updatedAt: "2026-09-08T06:00:00Z", status: { type: "idle" } }));
  let eventCount = 0;
  let taskCount = 0;
  const traceBatches: Array<Array<{ attributes?: Record<string, string> }>> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("/events")) {
      eventCount++;
      return { ok: true, status: 200, json: async () => ({ accepted: true, duplicate: false, sequence: eventCount }) };
    }
    if (url.endsWith("/traces/spans")) {
      traceBatches.push((JSON.parse(String(init.body)) as { spans: typeof traceBatches[number] }).spans);
    }
    return { ok: true, status: 200, json: async () => ({ accepted: true }) };
  }));
  let monitor: Monitor | undefined;
  try {
    monitor = await Monitor.create({ stateDirectory: directory, apiUrl: "https://trace.invalid", token: "synthetic", deviceId: "trace-device", onTasks(tasks) { taskCount = tasks.length; } });
    await monitor.start();
    const deadline = Date.now() + 5_000;
    while ((eventCount < 150 || !traceBatches.flat().some(span => Number(span.attributes?.traceDropped) > 0)) && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 25));
    await monitor.stop();
    expect(taskCount).toBe(150);
    expect(eventCount).toBe(150);
    expect(traceBatches.every(batch => batch.length <= 100)).toBe(true);
    expect(traceBatches.flat().some(span => Number(span.attributes?.traceDropped) > 0)).toBe(true);
  } finally {
    await monitor?.stop();
    mock.threads = undefined;
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);
