import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from "fastify";
import {
  IngestEventSchema,
  TraceSpanBatchSchema,
  PROTOCOL_VERSION,
  parseStrict,
  safeTraceSpan,
  protocolError,
  type IngestEvent,
  type ErrorCode,
} from "@codex-assistant/protocol";
import { registerStream } from "./stream.js";
import { TaskDatabase } from "./database.js";
import { ServerTracing } from "./tracing.js";

const API = "/codex-assistant/api/v3";
const TRACE_ID_PATTERN = /^[a-f0-9]{32}$/;

export type AppOptions = {
  databasePath: string;
  accessToken: string;
  logger?: boolean;
};

function bearer(request: FastifyRequest): string | undefined {
  const value = request.headers.authorization;
  const match =
    typeof value === "string" ? /^Bearer ([^\s]+)$/.exec(value) : undefined;
  return match?.[1];
}

function error(
  reply: FastifyReply,
  statusCode: number,
  code: ErrorCode,
  message: string,
): FastifyReply {
  return reply.status(statusCode).send(protocolError(code, message));
}

/** 创建隔离的 CodexAssistant API，不读写同机其他项目的数据。 */
export async function createApp(
  options: AppOptions,
): Promise<{ app: FastifyInstance; close: () => Promise<void> }> {
  if (options.accessToken.trim().length < 16)
    throw new Error("ACCESS_TOKEN_INVALID");
  const database = new TaskDatabase(options.databasePath);
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 128 * 1024,
  });
  const tracing = new ServerTracing(database);
  const stream = await registerStream(
    app,
    database,
    tracing,
    options.accessToken,
  );
  app.addHook("preClose", async () => stream.close());
  app.addHook("onClose", async () => {
    await tracing.close();
    database.close();
  });
  const requestSpans = new WeakMap<object, ReturnType<ServerTracing["http"]>>();
  app.addHook("onRequest", async (request) => {
    requestSpans.set(
      request,
      tracing.http(
        request.method,
        typeof request.headers.traceparent === "string"
          ? request.headers.traceparent
          : undefined,
      ),
    );
  });
  app.addHook("onResponse", async (request, reply) => {
    const span = requestSpans.get(request);
    span?.setAttributes({
      route: request.routeOptions.url ?? "unknown",
      status: reply.statusCode,
    });
    span?.end();
  });

  const authenticateHttp = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => {
    if (bearer(request) !== options.accessToken)
      return error(reply, 401, "auth_required", "Bearer token is required");
  };
  app.setErrorHandler((cause, request, reply) => {
    if ((cause as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE")
      return error(
        reply,
        413,
        "validation_failed",
        "Request body is too large",
      );
    if ((cause as { statusCode?: number }).statusCode === 400)
      return error(reply, 400, "validation_failed", "Invalid JSON request");
    request.log.error({ err: cause }, "codex-assistant request failed");
    return error(reply, 500, "internal_error", "Internal server error");
  });

  app.get("/codex-assistant/health", async () => ({
    status: "ok",
    protocolVersion: PROTOCOL_VERSION,
    uptimeSeconds: Math.trunc(process.uptime()),
    memoryRssBytes: process.memoryUsage().rss,
    cpuUsageMicros: process.cpuUsage(),
    traceFailedExports: tracing.failedExports,
    subscribers: stream.subscriberCount,
    notificationMode: "android_foreground_service",
    metrics: database.metrics(),
  }));

  app.post(
    `${API}/events`,
    { preHandler: authenticateHttp },
    async (request, reply) => {
      const body = parseStrict<IngestEvent>(IngestEventSchema, request.body);
      if (!body)
        return error(
          reply,
          422,
          "validation_failed",
          "Request does not match codex-assistant.v3",
        );
      const serverSpan = tracing.start("server.ingest", body.trace, {
        taskId: body.task.id,
      });
      let result;
      try {
        result = database.insert(body);
        serverSpan.setAttribute("duplicate", String(result.duplicate));
      } finally {
        serverSpan.end();
      }
      if (!result.duplicate) stream.broadcast(result.event);
      return {
        accepted: true,
        duplicate: result.duplicate,
        sequence: result.event.sequence,
      };
    },
  );

  app.post(
    `${API}/traces/spans`,
    { preHandler: authenticateHttp },
    async (request, reply) => {
      const body = parseStrict<
        import("@codex-assistant/protocol").TraceSpanBatch
      >(TraceSpanBatchSchema, request.body);
      if (!body)
        return error(
          reply,
          422,
          "validation_failed",
          "Trace span batch is invalid",
        );
      if (
        body.spans.some(
          (span) =>
            !Number.isFinite(Date.parse(span.startedAt)) ||
            !Number.isFinite(Date.parse(span.endedAt)) ||
            Date.parse(span.endedAt) < Date.parse(span.startedAt),
        )
      )
        return error(
          reply,
          422,
          "validation_failed",
          "Trace timestamps are invalid",
        );
      database.recordSpans(body.spans.map(safeTraceSpan));
      return { accepted: true, count: body.spans.length };
    },
  );

  app.get(`${API}/tasks`, { preHandler: authenticateHttp }, async () => ({
    protocolVersion: PROTOCOL_VERSION,
    cursor: database.cursor(),
    tasks: database.currentTasks(),
  }));

  app.get<{ Params: { traceId: string }; Querystring: { limit?: string } }>(
    `${API}/traces/:traceId`,
    { preHandler: authenticateHttp },
    async (request, reply) => {
      if (!TRACE_ID_PATTERN.test(request.params.traceId))
        return error(reply, 422, "validation_failed", "Invalid trace id");
      const limit = Number(request.query.limit ?? 1000);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        return error(
          reply,
          422,
          "validation_failed",
          "Trace limit must be 1..1000",
        );
      await tracing.flush();
      const spans = database.traceSpans(request.params.traceId, limit);
      if (spans.length === 0)
        return error(reply, 404, "trace_not_found", "Trace was not found");
      return {
        protocolVersion: PROTOCOL_VERSION,
        traceId: request.params.traceId,
        spans,
      };
    },
  );

  return { app, close: () => app.close() };
}
