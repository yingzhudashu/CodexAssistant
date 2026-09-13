import { randomBytes } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { context, propagation } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { ExportResultCode, W3CTraceContextPropagator, type ExportResult } from "@opentelemetry/core";
import { BatchSpanProcessor, BasicTracerProvider, type ReadableSpan, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import {
  ClientAuthMessageSchema,
  ClientSubscribeMessageSchema,
  ClientDetailMessageSchema,
  ClientSendMessageSchema,
  InteractionRequestSchema,
  InteractionSubmitMessageSchema,
  InteractionResultSchema,
  DetailMessageSchema,
  ResultMessageSchema,
  IngestEventSchema,
  TraceSpanBatchSchema,
  PROTOCOL_VERSION,
  type ErrorCode,
  type EventMessage,
  type IngestEvent,
  type ServerEvent,
  type ServerWebSocketMessage,
  type TraceContext,
  parseStrict,
  protocolError,
} from "@codex-assistant/protocol";
import { TaskDatabase } from "./database.js";

const API = "/codex-assistant/api/v3";
const MAX_REPLAY_EVENTS = 500;
const TRACE_ID_PATTERN = /^[a-f0-9]{32}$/;

export type AppOptions = { databasePath: string; accessToken: string; logger?: boolean };

function bearer(request: FastifyRequest): string | undefined {
  const value = request.headers.authorization;
  const match = typeof value === "string" ? /^Bearer ([^\s]+)$/.exec(value) : undefined;
  return match?.[1];
}

function error(reply: FastifyReply, statusCode: number, code: ErrorCode, message: string): FastifyReply {
  return reply.status(statusCode).send(protocolError(code, message));
}

function decodeJson(input: unknown): unknown | undefined {
  const text = Buffer.isBuffer(input) ? input.toString("utf8") : typeof input === "string" ? input : undefined;
  if (!text || Buffer.byteLength(text, "utf8") > 131_072) return undefined;
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

function id(bytes: number): string { return randomBytes(bytes).toString("hex"); }
function rootTrace(): TraceContext { return { traceId: id(16), spanId: id(8) }; }
function childTrace(parent: TraceContext): TraceContext { return { traceId: parent.traceId, spanId: id(8), parentSpanId: parent.spanId }; }

const contextManager = new AsyncLocalStorageContextManager().enable();
context.setGlobalContextManager(contextManager);
propagation.setGlobalPropagator(new W3CTraceContextPropagator());

/**
 * 将 OTel span 转成协议允许的最小记录。
 * exporter 只保留路由、状态码、任务 ID、阶段、计数、延迟和错误类别，
 * 防止 SDK 属性或异常对象把 Token、路径和正文带入本地数据库。
 */
class SQLiteSpanExporter implements SpanExporter {
  readonly #database: TaskDatabase;

  constructor(database: TaskDatabase) { this.#database = database; }

  export(spans: ReadableSpan[], callback: (result: ExportResult) => void): void {
    try {
      const allowed = new Set(["route", "status", "taskId", "phase", "count", "latencyMs", "error"]);
      for (const span of spans) {
        const attributes: Record<string, string> = {};
        for (const [key, value] of Object.entries(span.attributes)) {
          if (allowed.has(key) && (typeof value === "string" || typeof value === "number" || typeof value === "boolean")) attributes[key] = String(value).slice(0, 200);
        }
        const startMs = span.startTime[0] * 1000 + span.startTime[1] / 1_000_000;
        const endMs = span.endTime[0] * 1000 + span.endTime[1] / 1_000_000;
        const spanContext = span.spanContext();
        this.#database.recordSpan({
          traceId: spanContext.traceId,
          spanId: spanContext.spanId,
          ...(span.parentSpanContext?.spanId ? { parentSpanId: span.parentSpanContext.spanId } : {}),
          name: span.name.slice(0, 80),
          startedAt: new Date(startMs).toISOString(),
          endedAt: new Date(Math.max(startMs, endMs)).toISOString(),
          ...(Object.keys(attributes).length ? { attributes } : {}),
        });
      }
      callback({ code: ExportResultCode.SUCCESS });
    } catch {
      // Trace 是旁路诊断数据，SQLite 写入失败不能影响事件同步。
      callback({ code: ExportResultCode.FAILED });
    }
  }

  shutdown(): Promise<void> { return Promise.resolve(); }
  forceFlush(): Promise<void> { return Promise.resolve(); }
}

/** 创建隔离的 CodexAssistant API，不读写 RobotClaw 或 UmaAgent 数据。 */
export async function createApp(options: AppOptions): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  if (options.accessToken.trim().length < 16) throw new Error("ACCESS_TOKEN_INVALID");
  const database = new TaskDatabase(options.databasePath);
  const app = Fastify({ logger: options.logger ?? true, bodyLimit: 128 * 1024 });
  const subscribers = new Set<WebSocket>();
  const desktopControllers = new Set<WebSocket>();
  const pendingRequests = new Map<string, { target: WebSocket; controller: WebSocket; threadId: string }>();
  const interactionResults = new Map<string, import("@codex-assistant/protocol").InteractionResult>();
  const rememberInteractionResult = (result: import("@codex-assistant/protocol").InteractionResult) => { interactionResults.set(result.requestId, result); if (interactionResults.size > 1000) interactionResults.delete(interactionResults.keys().next().value!); };
  const interactions = new Map<string, { controller: WebSocket; request: import('@codex-assistant/protocol').InteractionRequest; submitted: boolean }>();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new BatchSpanProcessor(new SQLiteSpanExporter(database), { maxQueueSize: 256, maxExportBatchSize: 32, scheduledDelayMillis: 250 })],
  });
  const otelTracer = tracerProvider.getTracer("codex-assistant");
  const requestTraces = new WeakMap<object, { context: TraceContext; startedAt: string; otelSpan: ReturnType<typeof otelTracer.startSpan> }>();
  // 每个 HTTP 请求都自动生成 root/child span，日志中只保留安全的路由和状态码。
  app.addHook("onRequest", async (request) => {
    const parent = propagation.extract(context.active(), { traceparent: typeof request.headers.traceparent === "string" ? request.headers.traceparent : "" });
    const otelSpan = otelTracer.startSpan(`http.${request.method.toLowerCase()}`, undefined, parent);
    const spanContext = otelSpan.spanContext();
    const incoming = typeof request.headers.traceparent === "string" ? /^00-([a-f0-9]{32})-([a-f0-9]{16})-[0-9a-f]{2}$/.exec(request.headers.traceparent) : undefined;
    const requestContext: TraceContext = {
      traceId: spanContext.traceId,
      spanId: spanContext.spanId,
      ...(incoming ? { parentSpanId: incoming[2] } : {}),
    };
    requestTraces.set(request, { context: requestContext, startedAt: new Date().toISOString(), otelSpan });
  });
  app.addHook("onResponse", async (request, reply) => {
    const root = requestTraces.get(request);
    if (!root) return;
    root.otelSpan.setAttribute("route", request.routeOptions.url ?? "unknown");
    root.otelSpan.setAttribute("status", reply.statusCode);
    root.otelSpan.end();
    // 立即写入一份最小 span，保证响应后 trace 查询可见；OTel exporter 仍会幂等补写。
    database.recordSpan({ ...root.context, name: `http.${request.method.toLowerCase()}`, startedAt: root.startedAt, endedAt: new Date().toISOString(), attributes: { route: request.routeOptions.url ?? "unknown", status: String(reply.statusCode) } });
  });

  const authenticateHttp = async (request: FastifyRequest, reply: FastifyReply) => {
    if (bearer(request) !== options.accessToken) return error(reply, 401, "auth_required", "Bearer token is required");
  };
  const broadcast = (event: ServerEvent): void => {
    const message: EventMessage = { type: "event", protocolVersion: PROTOCOL_VERSION, event };
    const encoded = JSON.stringify(message);
    for (const socket of subscribers) {
      if (socket.readyState === 1 && socket.bufferedAmount < 256 * 1024) socket.send(encoded);
      else {
        subscribers.delete(socket);
        if (socket.readyState === 1) socket.close(1013, "Subscriber too slow; reconnect to synchronize");
      }
    }
  };

  await app.register(websocket, { options: { maxPayload: 131_072, perMessageDeflate: false } });
  app.setErrorHandler((cause, request, reply) => {
    if ((cause as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE") return error(reply, 413, "validation_failed", "Request body is too large");
    request.log.error({ err: cause }, "codex-assistant request failed");
    return error(reply, 500, "internal_error", "Internal server error");
  });

  app.get("/codex-assistant/health", async () => ({
    status: "ok",
    protocolVersion: PROTOCOL_VERSION,
    uptimeSeconds: Math.trunc(process.uptime()),
    memoryRssBytes: process.memoryUsage().rss,
    subscribers: subscribers.size,
    notificationMode: "android_foreground_service",
    metrics: database.metrics(),
  }));

  app.post(`${API}/events`, { preHandler: authenticateHttp }, async (request, reply) => {
    const body = parseStrict<IngestEvent>(IngestEventSchema, request.body);
    if (!body) return error(reply, 422, "validation_failed", "Request does not match codex-assistant.v3");
    const startedAt = new Date().toISOString();
    const serverSpan = childTrace(body.trace);
    const result = database.insert(body);
    database.recordSpan({ ...serverSpan, name: "server.ingest", startedAt, endedAt: new Date().toISOString(), attributes: { duplicate: String(result.duplicate), taskId: body.task.id } });
    if (!result.duplicate) broadcast(result.event);
    return { accepted: true, duplicate: result.duplicate, sequence: result.event.sequence };
  });

  app.post(`${API}/traces/spans`, { preHandler: authenticateHttp }, async (request, reply) => {
    const body = parseStrict<import("@codex-assistant/protocol").TraceSpanBatch>(TraceSpanBatchSchema, request.body);
    if (!body) return error(reply, 422, "validation_failed", "Trace span batch is invalid");
    database.recordSpans(body.spans);
    return { accepted: true, count: body.spans.length };
  });

  app.get(`${API}/tasks`, { preHandler: authenticateHttp }, async () => ({
    protocolVersion: PROTOCOL_VERSION,
    cursor: database.cursor(),
    tasks: database.currentTasks(),
  }));

  app.get<{ Params: { traceId: string }; Querystring: { limit?: string } }>(`${API}/traces/:traceId`, { preHandler: authenticateHttp }, async (request, reply) => {
    if (!TRACE_ID_PATTERN.test(request.params.traceId)) return error(reply, 422, "validation_failed", "Invalid trace id");
    const spans = database.traceSpans(request.params.traceId, Number(request.query.limit ?? 1000));
    if (spans.length === 0) return error(reply, 404, "trace_not_found", "Trace was not found");
    return { protocolVersion: PROTOCOL_VERSION, traceId: request.params.traceId, spans };
  });

  app.get(`${API}/stream`, { websocket: true }, (socket) => {
    const connectionTrace = rootTrace();
    const startedAt = new Date().toISOString();
    let authenticated = false;
    let subscribed = false;
    const reject = (code: ErrorCode, message: string): void => {
      socket.send(JSON.stringify(protocolError(code, message)));
      socket.close(1008, code);
    };
    socket.on("message", (raw) => {
      const payload = decodeJson(raw);
      if (!authenticated) {
        const auth = parseStrict<import("@codex-assistant/protocol").ClientAuthMessage>(ClientAuthMessageSchema, payload);
        if (!auth) return reject(
          typeof (payload as { protocolVersion?: unknown } | undefined)?.protocolVersion === "string" ? "protocol_unsupported" : "validation_failed",
          "First message must be codex-assistant.v3 auth",
        );
        if (auth.token !== options.accessToken) return reject("auth_required", "Invalid bearer token");
        authenticated = true;
        database.recordSpan({ ...connectionTrace, name: "websocket.auth", startedAt, endedAt: new Date().toISOString() });
        socket.send(JSON.stringify({ type: "authenticated", protocolVersion: PROTOCOL_VERSION } satisfies ServerWebSocketMessage));
        return;
      }
      if (subscribed) {
        const message = payload as Record<string, unknown> | undefined;
        if (message?.type === "role" && message.role === "desktop") { if (desktopControllers.size && !desktopControllers.has(socket)) return reject("validation_failed", "Only one workstation controller is supported"); desktopControllers.add(socket); return; }
        if (desktopControllers.has(socket)) {
          if (message?.type === 'interaction.result') {
            const result = parseStrict<import('@codex-assistant/protocol').InteractionResult>(InteractionResultSchema, payload);
            const interaction = result ? interactions.get(result.requestId) : undefined;
            if (result && !interaction && interactionResults.get(result.requestId)?.threadId === result.threadId) return;
            if (!result || !interaction || interaction.controller !== socket || interaction.request.threadId !== result.threadId) return reject('validation_failed', 'Interaction result does not match its owner');
            if (result.status === "failed") interaction.submitted = false;
            else { interactions.delete(result.requestId); rememberInteractionResult(result); }
            for (const peer of subscribers) if (peer !== socket && peer.readyState === 1) peer.send(JSON.stringify(result));
            return;
          }
          if (message?.type === "detail" || message?.type === "result" || message?.type === "interaction.request") {
            const requestId = typeof message.requestId === "string" ? message.requestId : undefined;
            if (message?.type === "interaction.request") {
              const request = parseStrict<import("@codex-assistant/protocol").InteractionRequest>(InteractionRequestSchema, payload);
              if (!request || !requestId) return reject("validation_failed", "Interaction request is invalid");
              const existing = interactions.get(requestId);
              if (existing && (existing.controller !== socket || existing.request.threadId !== request.threadId)) return reject('validation_failed', 'Duplicate interaction request id');
              if (existing) return;
              interactionResults.delete(requestId);
              interactions.set(requestId, { controller: socket, request, submitted: false });
              for (const peer of subscribers) if (peer.readyState === 1 && peer !== socket) peer.send(JSON.stringify(request));
              return;
            }
            const response = parseStrict<import('@codex-assistant/protocol').DetailMessage | import('@codex-assistant/protocol').ResultMessage>(message.type === 'detail' ? DetailMessageSchema : ResultMessageSchema, payload);
            if (!response) return reject('validation_failed', 'Invalid control response');
            const pending = pendingRequests.get(response.requestId);
            if (!pending) return;
            if (pending.controller !== socket || pending.threadId !== response.threadId) return reject('validation_failed', 'Control response does not match its owner');
            if (pending.target.readyState === 1) pending.target.send(JSON.stringify(response));
            pendingRequests.delete(response.requestId);
            return;
          }
          return reject("validation_failed", "Desktop control message is invalid");
        }
        const detail = parseStrict<import("@codex-assistant/protocol").ClientDetailMessage>(ClientDetailMessageSchema, payload);
        const send = parseStrict<import("@codex-assistant/protocol").ClientSendMessage>(ClientSendMessageSchema, payload);
        const interaction = parseStrict<import("@codex-assistant/protocol").InteractionSubmitMessage>(InteractionSubmitMessageSchema, payload);
        if (interaction) {
          const original = interactions.get(interaction.requestId);
          if (!original) {
            const prior = interactionResults.get(interaction.requestId);
            socket.send(JSON.stringify(prior?.threadId === interaction.threadId ? prior : { type: 'interaction.result', protocolVersion: PROTOCOL_VERSION, requestId: interaction.requestId, threadId: interaction.threadId, status: 'expired' }));
            return;
          }
          if (original.request.threadId !== interaction.threadId) return reject('validation_failed', 'Interaction request does not match its thread');
          if (original.submitted) return;
          if (original.controller.readyState !== 1) return;
          original.submitted = true;
          original.controller.send(JSON.stringify(interaction));
          return;
        }
        if (detail || send) {
          const requestId = detail?.requestId ?? send?.requestId;
          const controller = [...desktopControllers].find((peer) => peer.readyState === 1 && peer.bufferedAmount < 256 * 1024);
          const request = detail ?? send!;
          if (!controller || !requestId) {
            socket.send(JSON.stringify({ type: 'result', protocolVersion: PROTOCOL_VERSION, requestId: request.requestId, threadId: request.threadId, status: 'failed', error: '工作站未连接' }));
            return;
          }
          if (pendingRequests.has(requestId)) return reject('validation_failed', 'Duplicate control request id');
          pendingRequests.set(requestId, { target: socket, controller, threadId: request.threadId });
          controller.send(JSON.stringify(payload));
          return;
        }
        return reject("validation_failed", "Unsupported control message");
      }
      const subscribe = parseStrict<import("@codex-assistant/protocol").ClientSubscribeMessage>(ClientSubscribeMessageSchema, payload);
      if (!subscribe) return reject("validation_failed", "Expected codex-assistant.v3 subscribe message");
      subscribed = true;
      subscribers.add(socket);
      const replay = database.eventsAfter(subscribe.after, MAX_REPLAY_EVENTS);
      for (const event of replay) socket.send(JSON.stringify({ type: "event", protocolVersion: PROTOCOL_VERSION, event } satisfies ServerWebSocketMessage));
      socket.send(JSON.stringify({ type: "snapshot", protocolVersion: PROTOCOL_VERSION, cursor: database.cursor(), tasks: database.currentTasks() } satisfies ServerWebSocketMessage));
      for (const { request } of interactions.values()) socket.send(JSON.stringify(request));
      for (const result of interactionResults.values()) socket.send(JSON.stringify(result));
      database.recordSpan({ ...childTrace(connectionTrace), name: "websocket.subscribe", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), attributes: { replayCount: String(replay.length) } });
    });
    socket.on("close", () => {
      subscribers.delete(socket); desktopControllers.delete(socket);
      for (const [requestId, pending] of pendingRequests) {
        if (pending.controller === socket && pending.target.readyState === 1) pending.target.send(JSON.stringify({ type: 'result', protocolVersion: PROTOCOL_VERSION, requestId, threadId: pending.threadId, status: 'failed', error: '工作站连接已断开，结果尚未确认；请核实回合记录' }));
        if (pending.target === socket || pending.controller === socket) pendingRequests.delete(requestId);
      }
      for (const [requestId, entry] of interactions) if (entry.controller === socket) {
        interactions.delete(requestId);
        for (const peer of subscribers) if (peer.readyState === 1) peer.send(JSON.stringify({ type: 'interaction.result', protocolVersion: PROTOCOL_VERSION, requestId, threadId: entry.request.threadId, status: 'expired', error: '工作站连接已断开' }));
      }
    });
    socket.on("error", () => { subscribers.delete(socket); desktopControllers.delete(socket); });
  });

  return {
    app,
    close: async () => {
      for (const socket of subscribers) socket.close(1001, "server stopping");
      subscribers.clear();
      await app.close();
      await tracerProvider.shutdown().catch(() => undefined);
      database.close();
    },
  };
}
