import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, afterEach } from "vitest";
import WebSocket from "ws";
import { createApp } from "../src/app.js";

const token = "codex-assistant-test-token";
const task = { id: "thread-1", title: "Fix build", status: "active", runtimeStatus: "active", activeFlags: [], freshness: "fresh", source: "thread", plan: [], updatedAt: "2026-09-06T10:00:00.000Z", changedAt: "2026-09-06T10:00:00.000Z" } as const;
const event = { protocolVersion: "codex-assistant.v2", deviceId: "device-1", localSequence: 1, occurredAt: "2026-09-06T10:00:00.000Z", trace: { traceId: "0123456789abcdef0123456789abcdef", spanId: "0123456789abcdef" }, task };
const running: Array<Awaited<ReturnType<typeof createApp>>> = [];

afterEach(async () => { for (const server of running.splice(0)) await server.close(); });

describe("codex assistant server", () => {
  it("initializes schema, ingests idempotently, and returns snapshots", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-assistant-test-"));
    const server = await createApp({ databasePath: join(dir, "state.sqlite"), accessToken: token, logger: false }); running.push(server);
    const unauthorized = await server.app.inject({ method: "GET", url: "/codex-assistant/api/v2/tasks" });
    expect(unauthorized.statusCode).toBe(401);
    const first = await server.app.inject({ method: "POST", url: "/codex-assistant/api/v2/events", headers: { authorization: `Bearer ${token}` }, payload: event });
    expect(first.statusCode).toBe(200); expect(first.json()).toMatchObject({ accepted: true, duplicate: false, sequence: 1 });
    const duplicate = await server.app.inject({ method: "POST", url: "/codex-assistant/api/v2/events", headers: { authorization: `Bearer ${token}` }, payload: event });
    expect(duplicate.json()).toMatchObject({ accepted: true, duplicate: true, sequence: 1 });
    const snapshot = await server.app.inject({ method: "GET", url: "/codex-assistant/api/v2/tasks", headers: { authorization: `Bearer ${token}` } });
    expect(snapshot.json()).toMatchObject({ cursor: 1, tasks: [task] });
    const trace = await server.app.inject({ method: "GET", url: `/codex-assistant/api/v2/traces/${event.trace.traceId}`, headers: { authorization: `Bearer ${token}` } });
    expect(trace.statusCode).toBe(200); expect(trace.json().spans.length).toBeGreaterThan(0);
  });

  it("rejects unknown protocol fields", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-assistant-test-"));
    const server = await createApp({ databasePath: join(dir, "state.sqlite"), accessToken: token, logger: false }); running.push(server);
    const response = await server.app.inject({ method: "POST", url: "/codex-assistant/api/v2/events", headers: { authorization: `Bearer ${token}` }, payload: { ...event, extra: true } });
    expect(response.statusCode).toBe(422); expect(response.json().code).toBe("validation_failed");
  });

  it("accepts idempotent trace batches and rejects malformed spans", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-assistant-trace-test-"));
    const server = await createApp({ databasePath: join(dir, "state.sqlite"), accessToken: token, logger: false }); running.push(server);
    const span = { traceId: "abcdefabcdefabcdefabcdefabcdefab", spanId: "abcdefabcdefabcd", name: "android.websocket", startedAt: "2026-09-06T10:00:00.000Z", endedAt: "2026-09-06T10:00:00.010Z", attributes: { phase: "open", latencyMs: "10" } };
    const first = await server.app.inject({ method: "POST", url: "/codex-assistant/api/v2/traces/spans", headers: { authorization: `Bearer ${token}` }, payload: { protocolVersion: "codex-assistant.v2", spans: [span] } });
    expect(first.statusCode).toBe(200); expect(first.json()).toMatchObject({ accepted: true, count: 1 });
    const second = await server.app.inject({ method: "POST", url: "/codex-assistant/api/v2/traces/spans", headers: { authorization: `Bearer ${token}` }, payload: { protocolVersion: "codex-assistant.v2", spans: [span] } });
    expect(second.statusCode).toBe(200);
    const malformed = await server.app.inject({ method: "POST", url: "/codex-assistant/api/v2/traces/spans", headers: { authorization: `Bearer ${token}` }, payload: { protocolVersion: "codex-assistant.v2", spans: [{ ...span, extra: true }] } });
    expect(malformed.statusCode).toBe(422);
  });

  it("replays events after a cursor and sends a snapshot", async () => {
    const dir = await mkdtemp(join(tmpdir(), "codex-assistant-test-"));
    const server = await createApp({ databasePath: join(dir, "state.sqlite"), accessToken: token, logger: false }); running.push(server);
    await server.app.inject({ method: "POST", url: "/codex-assistant/api/v2/events", headers: { authorization: `Bearer ${token}` }, payload: event });
    await server.app.listen({ host: "127.0.0.1", port: 0 });
    const address = server.app.server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind");
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/codex-assistant/api/v2/stream`);
    const messages: unknown[] = [];
    socket.on("message", (value) => messages.push(JSON.parse(value.toString())));
    await new Promise<void>((resolve, reject) => { socket.once("open", () => resolve()); socket.once("error", reject); });
    socket.send(JSON.stringify({ type: "auth", protocolVersion: "codex-assistant.v2", token }));
    socket.send(JSON.stringify({ type: "subscribe", protocolVersion: "codex-assistant.v2", after: 0 }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(messages).toEqual(expect.arrayContaining([expect.objectContaining({ type: "authenticated" }), expect.objectContaining({ type: "event", event: expect.objectContaining({ sequence: 1 }) }), expect.objectContaining({ type: "snapshot", cursor: 1 })]));
    socket.close();
  });
});
