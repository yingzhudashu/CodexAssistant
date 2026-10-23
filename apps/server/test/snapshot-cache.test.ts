import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { TaskDatabase } from "../src/database.js";
import type { IngestEvent } from "@codex-assistant/protocol";

it("reuses an immutable snapshot until a new business transaction commits, and preserves history after restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-cache-"));
  const path = join(directory, "state.sqlite");
  let database = new TaskDatabase(path);
  const event: IngestEvent = {
    protocolVersion: "codex-assistant.v3",
    deviceId: "synthetic",
    localSequence: 1,
    occurredAt: "2026-10-23T00:00:00.000Z",
    trace: { traceId: "1".repeat(32), spanId: "2".repeat(16) },
    task: {
      id: "synthetic",
      title: "合成快照",
      status: "running",
      runtimeStatus: "active",
      activeFlags: [],
      freshness: "fresh",
      source: "thread",
      plan: [],
      updatedAt: "2026-10-23T00:00:00.000Z",
      changedAt: "2026-10-23T00:00:00.000Z",
    },
  };
  try {
    expect(database.currentTasks()).toEqual([]);
    database.insert(event);
    const first = database.currentTasks();
    const parse = vi.spyOn(JSON, "parse");
    expect(database.currentTasks()).toBe(first);
    expect(parse).not.toHaveBeenCalled();
    parse.mockRestore();
    expect(() =>
      first[0]!.plan.push({ id: "x", text: "污染", status: "pending" }),
    ).toThrow();
    database.insert(event);
    database.recordSpan({
      ...event.trace,
      name: "desktop.poll",
      startedAt: event.occurredAt,
      endedAt: event.occurredAt,
    });
    expect(database.currentTasks()).toBe(first);
    expect(() =>
      database.insert({
        ...event,
        deviceId: null as unknown as string,
        localSequence: 2,
      }),
    ).toThrow();
    expect(database.currentTasks()).toBe(first);
    database.insert({
      ...event,
      localSequence: 2,
      task: { ...event.task, status: "completed" },
    });
    expect(database.currentTasks()[0]!.status).toBe("completed");
    expect(first[0]!.status).toBe("running");
    database.close();
    database = new TaskDatabase(path);
    expect(database.currentTasks()[0]!.status).toBe("completed");
    expect(database.eventsAfter(0).map((value) => value.task.status)).toEqual([
      "running",
      "completed",
    ]);
  } finally {
    vi.restoreAllMocks();
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
