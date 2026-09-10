import { mkdtemp, writeFile, appendFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { LifecycleReader } from "../src/lifecycle.js";
import { applyLifecycle, ACTIVE_EVIDENCE_MAX_AGE_MS, IN_PROGRESS_ITEM_MAX_AGE_MS } from "../src/monitor.js";
import type { TaskSnapshot } from "@codex-assistant/protocol";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const event = (type: string, turn_id = "turn-1", seconds = 0, extra = {}) => JSON.stringify({ type: "event_msg", timestamp: `2026-09-08T06:00:${String(seconds).padStart(2, "0")}Z`, payload: { type, turn_id, ...extra } }) + "\n";
async function fixture(content: string) {
  const directory = await mkdtemp(join(tmpdir(), "codex-lifecycle-"));
  directories.push(directory);
  const path = join(directory, "rollout.jsonl");
  await writeFile(path, content);
  return { path, reader: new LifecycleReader() };
}

it("corrects interrupted/notLoaded from an independent app-server using actual start evidence", async () => {
  const { path, reader } = await fixture(event("task_started") + JSON.stringify({ type: "response_item", payload: "private content" }) + "\n");
  const task: TaskSnapshot = { id: "thread", title: "Task", runtimeStatus: "notLoaded", status: "needs_action", activeFlags: [], latestTurn: { status: "interrupted" }, source: "thread", freshness: "fresh", plan: [], updatedAt: "2026-09-08T06:00:00Z", changedAt: "2026-09-08T06:00:00Z" };
  expect(applyLifecycle(task, await reader.read("thread", path))).toMatchObject({ status: "running", runtimeStatus: "notLoaded", latestTurn: { status: "inProgress" } });
  await appendFile(path, event("task_complete", "turn-1", 2, { last_agent_message: "secret", error: null }));
  const result = applyLifecycle(task, await reader.read("thread", path));
  expect(result.status).toBe("completed");
  expect(JSON.stringify(result)).not.toMatch(/secret|private|rollout/);
  expect(applyLifecycle({ ...task, goal: { objective: "Goal", status: "needs_action", tokensUsed: 0, timeUsedSeconds: 0 } }, await reader.read("thread", path)).status).toBe("needs_action");
});

it("handles partial writes, late terminal events, aborts and failures without leaking error text", async () => {
  const { path, reader } = await fixture(event("task_started"));
  await reader.read("thread", path);
  const complete = event("task_complete", "turn-1", 1);
  await appendFile(path, complete.slice(0, 50));
  expect((await reader.read("thread", path))?.turn.status).toBe("inProgress");
  await appendFile(path, complete.slice(50) + event("task_started", "turn-2", 2) + event("turn_aborted", "turn-1", 3));
  expect((await reader.read("thread", path))?.turn.status).toBe("inProgress");
  await appendFile(path, event("turn_aborted", "turn-2", 4));
  expect((await reader.read("thread", path))?.turn.status).toBe("interrupted");
  await appendFile(path, event("task_started", "turn-3", 5) + event("task_complete", "turn-3", 6, { error: { message: "private error" } }));
  expect((await reader.read("thread", path))?.turn).toMatchObject({ status: "failed", error: { code: "TURN_FAILED", message: "回合执行失败" } });
});

it("finds the lifecycle across chunks and discards state after truncation or path changes", async () => {
  const { path, reader } = await fixture(event("task_started") + (JSON.stringify({ type: "response_item", text: "x".repeat(500) }) + "\n").repeat(300));
  expect((await reader.read("thread", path))?.turn.status).toBe("inProgress");
  await writeFile(path, event("task_complete"));
  expect((await reader.read("thread", path))?.turn.status).toBe("completed");
  const replacement = path + ".new";
  await writeFile(replacement, event("turn_aborted"));
  expect((await reader.read("thread", replacement))?.turn.status).toBe("interrupted");
  await expect(reader.read("thread", replacement + ".missing")).rejects.toThrow();
  expect(await reader.read("thread", null)).toBeUndefined();
});

it("keeps the state transition time separate from later metadata updates", async () => {
  const { path, reader } = await fixture(event("task_started"));
  const task: TaskSnapshot = { id: "thread", title: "Task", runtimeStatus: "notLoaded", status: "needs_action", activeFlags: [], source: "thread", freshness: "fresh", plan: [], updatedAt: "2026-09-08T06:10:00Z", changedAt: "2026-09-08T06:10:00Z" };
  const result = applyLifecycle(task, await reader.read("thread", path));
  expect(result).toMatchObject({ status: "running", updatedAt: task.updatedAt, changedAt: "2026-09-08T06:00:00.000Z" });
  // 不同 ISO 精度字符串必须按时间比较，不能让字母 Z 的字典序覆盖更晚的毫秒。
  const millisecond = applyLifecycle({ ...task, updatedAt: "2026-09-08T06:00:00Z" }, { turnId: "turn-1", turn: { status: "completed" }, updatedAt: "2026-09-08T06:00:00.500Z", evidenceAt: "2026-09-08T06:00:00.500Z" });
  expect(millisecond.updatedAt).toBe("2026-09-08T06:00:00.500Z");
});

const baseTask: TaskSnapshot = { id: "thread", title: "Task", runtimeStatus: "notLoaded", status: "needs_action", activeFlags: [], latestTurn: { status: "interrupted" }, source: "thread", freshness: "fresh", plan: [], updatedAt: "2026-09-08T06:00:00Z", changedAt: "2026-09-08T06:00:00Z" };

it("expires abandoned starts at cold startup and on repeated projection without changing source times", async () => {
  const { path, reader } = await fixture(event("task_started"));
  const time = Date.parse(baseTask.updatedAt);
  await utimes(path, time / 1000, time / 1000);
  const lifecycle = await reader.read("thread", path);
  const active = applyLifecycle(baseTask, lifecycle, time + 1);
  expect(active).toMatchObject({ status: "running", freshness: "fresh" });
  const expired = applyLifecycle(baseTask, lifecycle, time + ACTIVE_EVIDENCE_MAX_AGE_MS);
  expect(expired).toMatchObject({ status: "needs_action", freshness: "stale", latestTurn: { status: "inProgress" }, error: { code: "ACTIVE_EVIDENCE_EXPIRED" } });
  expect(expired.changedAt).toBe(active.changedAt);
  expect(expired.updatedAt).toBe(active.updatedAt);
  expect(baseTask.latestTurn?.status).toBe("interrupted");
  expect(applyLifecycle(baseTask, await new LifecycleReader().read("thread", path), time + 10 * ACTIVE_EVIDENCE_MAX_AGE_MS).status).toBe("needs_action");
});

it("keeps long tasks active while their file is updated, without reviving completed or aborted turns", async () => {
  const { path, reader } = await fixture(event("task_started"));
  const time = Date.parse(baseTask.updatedAt) + 24 * 60 * 60_000;
  await utimes(path, time / 1000, time / 1000);
  expect(applyLifecycle(baseTask, await reader.read("thread", path), time + 1000).status).toBe("running");
  await appendFile(path, event("task_complete", "turn-1", 1));
  expect(applyLifecycle(baseTask, await reader.read("thread", path), time + 10 * ACTIVE_EVIDENCE_MAX_AGE_MS).status).toBe("completed");
  await appendFile(path, event("task_started", "turn-2", 2) + event("turn_aborted", "turn-2", 3));
  expect(applyLifecycle(baseTask, await reader.read("thread", path), time).status).toBe("needs_action");
});

it("keeps a silent turn active while its current operation remains in progress", () => {
  const lifecycle = { turnId: "turn-1", turn: { status: "inProgress" as const }, updatedAt: baseTask.updatedAt, evidenceAt: baseTask.updatedAt };
  const now = Date.parse(lifecycle.evidenceAt) + ACTIVE_EVIDENCE_MAX_AGE_MS + 1;
  expect(applyLifecycle(baseTask, lifecycle, now, true)).toMatchObject({ status: "running", freshness: "stale", latestTurn: { status: "inProgress" } });
  const paused = { ...baseTask, goal: { objective: "Goal", status: "needs_action" as const, tokensUsed: 0, timeUsedSeconds: 0 } };
  expect(applyLifecycle(paused, lifecycle, now, true).status).toBe("needs_action");
  expect(applyLifecycle(baseTask, lifecycle, Date.parse(lifecycle.evidenceAt) + IN_PROGRESS_ITEM_MAX_AGE_MS, true).status).toBe("needs_action");
});

it("does not let old or invalid evidence override official activity or Goal constraints", async () => {
  const { path, reader } = await fixture(event("task_started"));
  const lifecycle = (await reader.read("thread", path))!;
  const now = Date.parse(lifecycle.evidenceAt) + ACTIVE_EVIDENCE_MAX_AGE_MS;
  for (const evidenceAt of [lifecycle.evidenceAt, "invalid", new Date(now + 60_000).toISOString()]) {
    const evidence = { ...lifecycle, evidenceAt };
    expect(applyLifecycle(baseTask, evidence, now).status).toBe("needs_action");
    const official: TaskSnapshot = { ...baseTask, runtimeStatus: "running", status: "needs_action", activeFlags: ["waitingOnApproval"] };
    expect(applyLifecycle(official, evidence, now)).toBe(official);
    for (const status of ["paused", "blocked", "completed", "usage_limited", "budget_limited", "running"] as const) {
      const task = { ...baseTask, goal: { objective: "Goal", status, tokensUsed: 0, timeUsedSeconds: 0 } };
      const result = applyLifecycle(task, evidence, now);
      expect(result.status).toBe(status === "running" ? "needs_action" : "needs_action");
      expect(result.goal?.status).toBe(status);
    }
  }
});
