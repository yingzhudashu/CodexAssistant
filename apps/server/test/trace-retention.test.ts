import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { TaskDatabase } from "../src/database.js";

it("bounds trace retention by arrival order, keeps newer arrivals and prunes again on restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-trace-retention-"));
  const path = join(directory, "state.sqlite");
  let database = new TaskDatabase(path);
  const span = (id: number) => ({
    traceId: id.toString(16).padStart(32, "0"),
    spanId: id.toString(16).padStart(16, "0"),
    name: "test",
    startedAt: "2026-09-08T00:00:00.000Z",
    endedAt: "2026-09-08T00:00:00.001Z",
  });
  try {
    // 同时间戳、客户端未来时间均不能保护旧记录免遭清理。
    database.recordSpans(
      Array.from({ length: 100_001 }, (_, i) => ({
        ...span(i + 1),
        ...(i === 0 ? { startedAt: "2099-01-01T00:00:00.000Z" } : {}),
      })),
    );
    expect(database.metrics().traceSpanCount).toBe(100_000);
    expect(database.metrics().tracePrunedSpans).toBe(1);
    expect(database.traceSpans(span(1).traceId)).toEqual([]);
    expect(database.traceSpans(span(100_001).traceId)).toHaveLength(1);
    database.recordSpan(span(100_002));
    database.recordSpan(span(100_002));
    expect(database.metrics().traceSpanCount).toBe(100_001);
    database.close();
    database = new TaskDatabase(path);
    expect(database.metrics().traceSpanCount).toBe(100_000);
    expect(database.metrics().tracePrunedSpans).toBe(1);
    expect(database.metrics().eventCount).toBe(0);
    expect(database.traceSpans(span(100_002).traceId)).toHaveLength(1);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 15_000);

it("returns spans in durable arrival order when client timestamps are equal or skewed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "codex-trace-order-"));
  const database = new TaskDatabase(join(directory, "state.sqlite"));
  const traceId = "a".repeat(32);
  try {
    database.recordSpans([
      {
        traceId,
        spanId: "1".repeat(16),
        name: "desktop.poll",
        startedAt: "2099-01-01T00:00:00.000Z",
        endedAt: "2099-01-01T00:00:00.001Z",
      },
      {
        traceId,
        spanId: "2".repeat(16),
        parentSpanId: "1".repeat(16),
        name: "server.ingest",
        startedAt: "2000-01-01T00:00:00.000Z",
        endedAt: "2000-01-01T00:00:00.001Z",
      },
    ]);
    expect(database.traceSpans(traceId).map((span) => span.spanId)).toEqual([
      "1".repeat(16),
      "2".repeat(16),
    ]);
  } finally {
    database.close();
    await rm(directory, { recursive: true, force: true });
  }
});
