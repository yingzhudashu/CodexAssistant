import { appendFile, mkdtemp, rename, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { IngestEvent, TaskSnapshot } from "@codex-assistant/protocol";
import { Monitor, ACTIVE_EVIDENCE_MAX_AGE_MS, IN_PROGRESS_ITEM_MAX_AGE_MS } from "../src/monitor.js";

const mock = vi.hoisted(() => ({ path: "", reads: 0, activeItem: true, revision: 0 }));
vi.mock("../src/app-server.js", () => ({
  CodexAppServer: class {
    async start() {} async stop() {} setTraceContext() {}
    async listThreads() { return [{ id: "thread", path: mock.path, status: { type: "notLoaded" }, updatedAt: "2026-09-08T06:00:00Z" }]; }
    async readThread() { mock.reads++; return {}; }
    async getGoal() { return undefined; }
    async listTurns() { return { data: [{ status: "interrupted" }] }; }
    async listItems() { return { data: mock.activeItem ? [{ turnId: "turn-1", item: { type: "commandExecution", status: "inProgress" } }] : [] }; }
    latestTurn() { return undefined; } planFor() { return undefined; } planRevision() { return mock.revision; }
  },
}));

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
    expect(snapshots.at(-1)).toMatchObject({ status: "active", freshness: "fresh" });

    now += ACTIVE_EVIDENCE_MAX_AGE_MS;
    await waitForPoll();
    expect(snapshots.at(-1)).toMatchObject({ status: "active", freshness: "stale" });

    now += IN_PROGRESS_ITEM_MAX_AGE_MS - ACTIVE_EVIDENCE_MAX_AGE_MS;
    await waitForPoll();
    expect(snapshots.at(-1)).toMatchObject({ status: "idle", freshness: "stale", error: { code: "ACTIVE_EVIDENCE_EXPIRED" } });

    mock.activeItem = false;
    mock.revision++;
    await appendFile(mock.path, JSON.stringify({ type: "event_msg", timestamp: new Date(now).toISOString(), payload: { type: "token_count" } }) + "\n");
    await utimes(mock.path, now / 1000, now / 1000);
    await waitForPoll();
    expect(snapshots.at(-1)).toMatchObject({ status: "active", freshness: "fresh" });

    await rename(mock.path, mock.path + ".held");
    now += ACTIVE_EVIDENCE_MAX_AGE_MS;
    await waitForPoll();
    expect(snapshots.at(-1)).toMatchObject({ status: "idle", freshness: "stale", error: { code: "ACTIVE_EVIDENCE_EXPIRED" } });

    await rename(mock.path + ".held", mock.path);
    await appendFile(mock.path, event("task_complete"));
    await waitForPoll();
    expect(snapshots.at(-1)).toMatchObject({ status: "complete", freshness: "fresh" });
    expect(mock.reads).toBe(2); // 状态投影按证据时间重算；只有计划修订时重新读取详情。
    expect(uploaded.map(row => row.task.status)).toEqual(["active", "active", "idle", "active", "idle", "complete"]);
    expect(uploaded.map(row => row.localSequence)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(JSON.stringify(uploaded)).not.toContain("evidenceAt");
  } finally {
    await monitor?.stop();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await rm(directory, { recursive: true, force: true });
  }
}, 20_000);
