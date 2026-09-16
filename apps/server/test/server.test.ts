import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach, vi } from "vitest";
import { TaskDatabase } from "../src/database.js";
import WebSocket from "ws";
import { createApp } from "../src/app.js";

const token = "codex-assistant-test-token";
const task = { id: "thread-1", title: "Fix build", status: "running", runtimeStatus: "active", activeFlags: [], freshness: "fresh", source: "thread", plan: [], updatedAt: "2026-09-06T10:00:00.000Z", changedAt: "2026-09-06T10:00:00.000Z" } as const;
const event = { protocolVersion: "codex-assistant.v3", deviceId: "device-1", localSequence: 1, occurredAt: "2026-09-06T10:00:00.000Z", trace: { traceId: "0123456789abcdef0123456789abcdef", spanId: "0123456789abcdef" }, task };
const running: Array<Awaited<ReturnType<typeof createApp>>> = [];
const directories: string[] = [];

afterEach(async () => {
  for (const server of running.splice(0)) await server.close();
  // 先关闭 SQLite/WS，再删除本用例创建的临时目录，避免回归测试持续留下数据库。
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe("codex assistant server", () => {
  it("keeps committed business events available when the trace exporter fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-trace-fault-")); directories.push(dir);
    const server = await createApp({ databasePath: join(dir, "state.sqlite"), accessToken: token, logger: false }); running.push(server);
    const failure = vi.spyOn(TaskDatabase.prototype, "recordSpans").mockImplementation(() => { throw new Error("DISK_FULL"); });
    try {
      const headers = { authorization: `Bearer ${token}` };
      expect((await server.app.inject({ method: "POST", url: "/codex-assistant/api/v3/events", headers, payload: event })).json()).toMatchObject({ accepted: true, sequence: 1 });
      await server.app.inject({ method: "GET", url: `/codex-assistant/api/v3/traces/${event.trace.traceId}`, headers });
      expect((await server.app.inject({ method: "GET", url: "/codex-assistant/api/v3/tasks", headers })).json()).toMatchObject({ cursor: 1, tasks: [task] });
      expect((await server.app.inject({ method: "GET", url: "/codex-assistant/health" })).json().traceFailedExports).toBeGreaterThan(0);
    } finally { failure.mockRestore(); }
  });

  it("sanitizes uploaded diagnostics and validates query bounds and timestamps", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-trace-safety-")); directories.push(dir);
    const server = await createApp({ databasePath: join(dir, "state.sqlite"), accessToken: token, logger: false }); running.push(server);
    const headers = { authorization: `Bearer ${token}` };
    const url = `/codex-assistant/api/v3/traces/${event.trace.traceId}`;
    const span = { ...event.trace, name: "desktop.upload", startedAt: event.occurredAt, endedAt: event.occurredAt, attributes: { token: "secret", error: "C:/private/key", latencyMs: "2", route: "/codex-assistant/api/v3/tasks?token=secret" } };
    expect((await server.app.inject({ method: "POST", url: "/codex-assistant/api/v3/traces/spans", headers, payload: { protocolVersion: event.protocolVersion, spans: [span] } })).statusCode).toBe(200);
    const trace = (await server.app.inject({ method: "GET", url, headers })).json();
    expect(trace.spans.find((entry: { spanId: string }) => entry.spanId === span.spanId).attributes).toEqual({ error: "OPERATION_FAILED", latencyMs: "2" });
    for (const limit of ["NaN", "1.5", "-1", "1001", "Infinity", "0"]) expect((await server.app.inject({ method: "GET", url: `${url}?limit=${limit}`, headers })).statusCode).toBe(422);
    expect((await server.app.inject({ method: "POST", url: "/codex-assistant/api/v3/traces/spans", headers, payload: { protocolVersion: event.protocolVersion, spans: [{ ...span, endedAt: "2020-01-01T00:00:00Z" }] } })).statusCode).toBe(422);
    expect((await server.app.inject({ method: "POST", url: "/codex-assistant/api/v3/events", headers: { ...headers, "content-type": "application/json" }, payload: "{" })).statusCode).toBe(400);
  });

  it("propagates W3C parent context and closes unauthenticated connections promptly", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-parent-")); directories.push(dir);
    const server = await createApp({ databasePath: join(dir, "state.sqlite"), accessToken: token, logger: false });
    const headers = { authorization: `Bearer ${token}`, traceparent: `00-${event.trace.traceId}-${event.trace.spanId}-01` };
    await server.app.inject({ method: "POST", url: "/codex-assistant/api/v3/events", headers, payload: event });
    const trace = (await server.app.inject({ method: "GET", url: `/codex-assistant/api/v3/traces/${event.trace.traceId}`, headers: { authorization: `Bearer ${token}` } })).json();
    expect(trace.spans).toEqual(expect.arrayContaining([expect.objectContaining({ name: "http.post", parentSpanId: event.trace.spanId }), expect.objectContaining({ name: "server.ingest", parentSpanId: event.trace.spanId })]));
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const address = server.app.server.address() as { port: number };
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/codex-assistant/api/v3/stream`);
    await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
    try { await server.close(); } finally { socket.terminate(); }
  });
  it("rejects the old protocol, endpoint and task statuses without compatibility conversion", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-protocol-boundary-"));
    directories.push(dir);
    const server = await createApp({ databasePath: join(dir, "state.sqlite"), accessToken: token, logger: false }); running.push(server);
    const headers = { authorization: `Bearer ${token}` };
    const oldEndpoint = await server.app.inject({ method: "GET", url: "/codex-assistant/api/v2/tasks", headers });
    expect(oldEndpoint.statusCode).toBe(404);
    for (const payload of [{ ...event, protocolVersion: "codex-assistant.v2" }, { ...event, task: { ...task, status: "active" } }]) {
      const response = await server.app.inject({ method: "POST", url: "/codex-assistant/api/v3/events", headers, payload });
      expect(response.statusCode).toBe(422);
    }
  });

  it("initializes schema, ingests idempotently, and returns snapshots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-assistant-test-"));
    directories.push(dir);
    const server = await createApp({ databasePath: join(dir, "state.sqlite"), accessToken: token, logger: false }); running.push(server);
    const unauthorized = await server.app.inject({ method: "GET", url: "/codex-assistant/api/v3/tasks" });
    expect(unauthorized.statusCode).toBe(401);
    const first = await server.app.inject({ method: "POST", url: "/codex-assistant/api/v3/events", headers: { authorization: `Bearer ${token}` }, payload: event });
    expect(first.statusCode).toBe(200); expect(first.json()).toMatchObject({ accepted: true, duplicate: false, sequence: 1 });
    const duplicate = await server.app.inject({ method: "POST", url: "/codex-assistant/api/v3/events", headers: { authorization: `Bearer ${token}` }, payload: event });
    expect(duplicate.json()).toMatchObject({ accepted: true, duplicate: true, sequence: 1 });
    const snapshot = await server.app.inject({ method: "GET", url: "/codex-assistant/api/v3/tasks", headers: { authorization: `Bearer ${token}` } });
    expect(snapshot.json()).toMatchObject({ cursor: 1, tasks: [task] });
    const trace = await server.app.inject({ method: "GET", url: `/codex-assistant/api/v3/traces/${event.trace.traceId}`, headers: { authorization: `Bearer ${token}` } });
    expect(trace.statusCode).toBe(200); expect(trace.json().spans.length).toBeGreaterThan(0);
  });

  it("rejects unknown protocol fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-assistant-test-"));
    directories.push(dir);
    const server = await createApp({ databasePath: join(dir, "state.sqlite"), accessToken: token, logger: false }); running.push(server);
    const response = await server.app.inject({ method: "POST", url: "/codex-assistant/api/v3/events", headers: { authorization: `Bearer ${token}` }, payload: { ...event, extra: true } });
    expect(response.statusCode).toBe(422); expect(response.json().code).toBe("validation_failed");
  });

  it("accepts idempotent trace batches and rejects malformed spans", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-assistant-trace-test-"));
    directories.push(dir);
    const server = await createApp({ databasePath: join(dir, "state.sqlite"), accessToken: token, logger: false }); running.push(server);
    const span = { traceId: "abcdefabcdefabcdefabcdefabcdefab", spanId: "abcdefabcdefabcd", name: "android.websocket", startedAt: "2026-09-06T10:00:00.000Z", endedAt: "2026-09-06T10:00:00.010Z", attributes: { phase: "open", latencyMs: "10" } };
    const first = await server.app.inject({ method: "POST", url: "/codex-assistant/api/v3/traces/spans", headers: { authorization: `Bearer ${token}` }, payload: { protocolVersion: "codex-assistant.v3", spans: [span] } });
    expect(first.statusCode).toBe(200); expect(first.json()).toMatchObject({ accepted: true, count: 1 });
    const second = await server.app.inject({ method: "POST", url: "/codex-assistant/api/v3/traces/spans", headers: { authorization: `Bearer ${token}` }, payload: { protocolVersion: "codex-assistant.v3", spans: [span] } });
    expect(second.statusCode).toBe(200);
    const malformed = await server.app.inject({ method: "POST", url: "/codex-assistant/api/v3/traces/spans", headers: { authorization: `Bearer ${token}` }, payload: { protocolVersion: "codex-assistant.v3", spans: [{ ...span, extra: true }] } });
    expect(malformed.statusCode).toBe(422);
  });

  it("replays events after a cursor and sends a snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-assistant-test-"));
    directories.push(dir);
    const server = await createApp({ databasePath: join(dir, "state.sqlite"), accessToken: token, logger: false }); running.push(server);
    await server.app.inject({ method: "POST", url: "/codex-assistant/api/v3/events", headers: { authorization: `Bearer ${token}` }, payload: event });
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const address = server.app.server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/codex-assistant/api/v3/stream`);
    const messages: unknown[] = [];
    socket.on("message", (value) => messages.push(JSON.parse(value.toString())));
    await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
    socket.send(JSON.stringify({ type: "auth", protocolVersion: "codex-assistant.v3", token }));
    socket.send(JSON.stringify({ type: "subscribe", protocolVersion: "codex-assistant.v3", after: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ type: "authenticated" }), expect.objectContaining({ type: "event", event: expect.objectContaining({ sequence: 1 }) }), expect.objectContaining({ type: "snapshot", cursor: 1 })]));
    socket.close();
  });
});
