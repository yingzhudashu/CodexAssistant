import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
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
  PROTOCOL_VERSION,
  parseStrict,
  protocolError,
  type TraceContext,
  type ErrorCode,
  type ServerEvent,
  type EventMessage,
  type ServerWebSocketMessage,
} from "@codex-assistant/protocol";
import type { TaskDatabase } from "./database.js";
import type { ServerTracing } from "./tracing.js";
const API = "/codex-assistant/api/v3";
const MAX_REPLAY_EVENTS = 500;
function decodeJson(input: unknown): unknown | undefined {
  const text = Buffer.isBuffer(input)
    ? input.toString("utf8")
    : typeof input === "string"
      ? input
      : undefined;
  if (!text || Buffer.byteLength(text, "utf8") > 131_072) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function id(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}
function rootTrace(): TraceContext {
  return { traceId: id(16), spanId: id(8) };
}

/** WebSocket 模块独占连接、控制路由和交互生命周期，HTTP 层只调用广播。 */
export async function registerStream(
  app: FastifyInstance,
  database: TaskDatabase,
  tracing: ServerTracing,
  accessToken: string,
) {
  const subscribers = new Set<WebSocket>();
  const connections = new Set<WebSocket>();
  // 对所有实时发送使用同一背压边界；批量初始快照单独校准。
  const sendSocket = (socket: WebSocket, encoded: string): boolean => {
    if (socket.readyState !== 1) return false;
    if (socket.bufferedAmount >= 256 * 1024) {
      socket.close(1013, "Reconnect to synchronize");
      return false;
    }
    socket.send(encoded);
    return true;
  };
  const desktopControllers = new Set<WebSocket>();
  const pendingRequests = new Map<
    string,
    {
      target: WebSocket;
      controller: WebSocket;
      threadId: string;
      deadline: number;
    }
  >();
  const interactionResults = new Map<
    string,
    import("@codex-assistant/protocol").InteractionResult
  >();
  const rememberInteractionResult = (
    result: import("@codex-assistant/protocol").InteractionResult,
  ) => {
    interactionResults.set(result.requestId, result);
    if (interactionResults.size > 1000)
      interactionResults.delete(interactionResults.keys().next().value!);
  };
  const interactions = new Map<
    string,
    {
      controller: WebSocket;
      request: import("@codex-assistant/protocol").InteractionRequest;
      submitted: boolean;
    }
  >();
  // 一只定时器管理有界请求表，避免每个请求持有额外定时器。
  const expiry = setInterval(() => {
    for (const [requestId, pending] of pendingRequests)
      if (pending.deadline <= Date.now()) {
        pendingRequests.delete(requestId);
        sendSocket(
          pending.target,
          JSON.stringify({
            type: "result",
            protocolVersion: PROTOCOL_VERSION,
            requestId,
            threadId: pending.threadId,
            status: "failed",
            error: "工作站响应超时，结果尚未确认；请核实回合记录",
          }),
        );
      }
  }, 1000);
  expiry.unref();
  const broadcast = (event: ServerEvent): void => {
    const message: EventMessage = {
      type: "event",
      protocolVersion: PROTOCOL_VERSION,
      event,
    };
    const encoded = JSON.stringify(message);
    for (const socket of subscribers) {
      if (!sendSocket(socket, encoded)) subscribers.delete(socket);
    }
  };

  await app.register(websocket, {
    options: { maxPayload: 131_072, perMessageDeflate: false },
  });
  app.get(`${API}/stream`, { websocket: true }, (socket) => {
    connections.add(socket);
    const handshake = setTimeout(() => socket.terminate(), 15_000);
    handshake.unref();
    const connectionTrace = rootTrace();
    let authenticated = false;
    let subscribed = false;
    const reject = (code: ErrorCode, message: string): void => {
      sendSocket(socket, JSON.stringify(protocolError(code, message)));
      socket.close(1008, code);
    };
    socket.on("message", (raw) => {
      const payload = decodeJson(raw);
      if (!authenticated) {
        const auth = parseStrict<
          import("@codex-assistant/protocol").ClientAuthMessage
        >(ClientAuthMessageSchema, payload);
        if (!auth)
          return reject(
            typeof (payload as { protocolVersion?: unknown } | undefined)
              ?.protocolVersion === "string"
              ? "protocol_unsupported"
              : "validation_failed",
            "First message must be codex-assistant.v3 auth",
          );
        if (auth.token !== accessToken)
          return reject("auth_required", "Invalid bearer token");
        authenticated = true;
        tracing.start("websocket.auth", connectionTrace).end();
        sendSocket(
          socket,
          JSON.stringify({
            type: "authenticated",
            protocolVersion: PROTOCOL_VERSION,
          } satisfies ServerWebSocketMessage),
        );
        return;
      }
      if (subscribed) {
        const message = payload as Record<string, unknown> | undefined;
        if (
          message?.type === "role" &&
          message.role === "desktop" &&
          message.protocolVersion === PROTOCOL_VERSION &&
          Object.keys(message).length === 3
        ) {
          if (desktopControllers.size && !desktopControllers.has(socket))
            return reject(
              "validation_failed",
              "Only one workstation controller is supported",
            );
          desktopControllers.add(socket);
          return;
        }
        if (desktopControllers.has(socket)) {
          if (message?.type === "interaction.result") {
            const result = parseStrict<
              import("@codex-assistant/protocol").InteractionResult
            >(InteractionResultSchema, payload);
            const interaction = result
              ? interactions.get(result.requestId)
              : undefined;
            if (
              result &&
              !interaction &&
              interactionResults.get(result.requestId)?.threadId ===
                result.threadId
            )
              return;
            if (
              !result ||
              !interaction ||
              interaction.controller !== socket ||
              interaction.request.threadId !== result.threadId
            )
              return reject(
                "validation_failed",
                "Interaction result does not match its owner",
              );
            if (result.status === "failed") interaction.submitted = false;
            else {
              interactions.delete(result.requestId);
              rememberInteractionResult(result);
            }
            for (const peer of subscribers)
              if (peer !== socket && peer.readyState === 1)
                sendSocket(peer, JSON.stringify(result));
            return;
          }
          if (
            message?.type === "detail" ||
            message?.type === "result" ||
            message?.type === "interaction.request"
          ) {
            const requestId =
              typeof message.requestId === "string"
                ? message.requestId
                : undefined;
            if (message?.type === "interaction.request") {
              const request = parseStrict<
                import("@codex-assistant/protocol").InteractionRequest
              >(InteractionRequestSchema, payload);
              if (!request || !requestId)
                return reject(
                  "validation_failed",
                  "Interaction request is invalid",
                );
              const existing = interactions.get(requestId);
              if (
                existing &&
                (existing.controller !== socket ||
                  existing.request.threadId !== request.threadId)
              )
                return reject(
                  "validation_failed",
                  "Duplicate interaction request id",
                );
              if (existing) return;
              if (interactions.size >= 1000)
                return reject(
                  "validation_failed",
                  "Too many pending interactions",
                );
              interactionResults.delete(requestId);
              interactions.set(requestId, {
                controller: socket,
                request,
                submitted: false,
              });
              for (const peer of subscribers)
                if (peer.readyState === 1 && peer !== socket)
                  sendSocket(peer, JSON.stringify(request));
              return;
            }
            const response = parseStrict<
              | import("@codex-assistant/protocol").DetailMessage
              | import("@codex-assistant/protocol").ResultMessage
            >(
              message.type === "detail"
                ? DetailMessageSchema
                : ResultMessageSchema,
              payload,
            );
            if (!response)
              return reject("validation_failed", "Invalid control response");
            const pending = pendingRequests.get(response.requestId);
            if (!pending) return;
            if (
              pending.controller !== socket ||
              pending.threadId !== response.threadId
            )
              return reject(
                "validation_failed",
                "Control response does not match its owner",
              );
            if (pending.target.readyState === 1)
              sendSocket(pending.target, JSON.stringify(response));
            pendingRequests.delete(response.requestId);
            return;
          }
          return reject(
            "validation_failed",
            "Desktop control message is invalid",
          );
        }
        const detail = parseStrict<
          import("@codex-assistant/protocol").ClientDetailMessage
        >(ClientDetailMessageSchema, payload);
        const send = parseStrict<
          import("@codex-assistant/protocol").ClientSendMessage
        >(ClientSendMessageSchema, payload);
        const interaction = parseStrict<
          import("@codex-assistant/protocol").InteractionSubmitMessage
        >(InteractionSubmitMessageSchema, payload);
        if (interaction) {
          const original = interactions.get(interaction.requestId);
          if (!original) {
            const prior = interactionResults.get(interaction.requestId);
            sendSocket(
              socket,
              JSON.stringify(
                prior?.threadId === interaction.threadId
                  ? prior
                  : {
                      type: "interaction.result",
                      protocolVersion: PROTOCOL_VERSION,
                      requestId: interaction.requestId,
                      threadId: interaction.threadId,
                      status: "expired",
                    },
              ),
            );
            return;
          }
          if (original.request.threadId !== interaction.threadId)
            return reject(
              "validation_failed",
              "Interaction request does not match its thread",
            );
          if (original.submitted) return;
          if (original.controller.readyState !== 1) return;
          original.submitted = true;
          sendSocket(original.controller, JSON.stringify(interaction));
          return;
        }
        if (detail || send) {
          const requestId = detail?.requestId ?? send?.requestId;
          const controller = [...desktopControllers].find(
            (peer) => peer.readyState === 1 && peer.bufferedAmount < 256 * 1024,
          );
          const request = detail ?? send!;
          if (!controller || !requestId) {
            sendSocket(
              socket,
              JSON.stringify({
                type: "result",
                protocolVersion: PROTOCOL_VERSION,
                requestId: request.requestId,
                threadId: request.threadId,
                status: "failed",
                error: "工作站未连接",
              }),
            );
            return;
          }
          if (pendingRequests.has(requestId))
            return reject("validation_failed", "Duplicate control request id");
          if (pendingRequests.size >= 256) {
            sendSocket(
              socket,
              JSON.stringify({
                type: "result",
                protocolVersion: PROTOCOL_VERSION,
                requestId,
                threadId: request.threadId,
                status: "failed",
                error: "工作站请求繁忙，请稍后重试",
              }),
            );
            return;
          }
          pendingRequests.set(requestId, {
            target: socket,
            controller,
            threadId: request.threadId,
            deadline: Date.now() + 30_000,
          });
          sendSocket(controller, JSON.stringify(payload));
          return;
        }
        return reject("validation_failed", "Unsupported control message");
      }
      const subscribe = parseStrict<
        import("@codex-assistant/protocol").ClientSubscribeMessage
      >(ClientSubscribeMessageSchema, payload);
      if (!subscribe)
        return reject(
          "validation_failed",
          "Expected codex-assistant.v3 subscribe message",
        );
      subscribed = true;
      clearTimeout(handshake);
      subscribers.add(socket);
      const replay = database.eventsAfter(subscribe.after, MAX_REPLAY_EVENTS);
      // 回放只为提示增量，最终完整快照才是恢复依据；缓冲超过预算时直接校准。
      for (const event of replay) {
        if (socket.bufferedAmount >= 256 * 1024) break;
        socket.send(
          JSON.stringify({
            type: "event",
            protocolVersion: PROTOCOL_VERSION,
            event,
          } satisfies ServerWebSocketMessage),
        );
      }
      // 快照可能大于实时发送预算。等待已排队字节写完再逐条发送交互，
      // 避免一次把最多1000个大型表单塞进缓冲，也避免因快照大小无限重连。
      function* pendingReplay() {
        for (const { request } of interactions.values())
          yield JSON.stringify(request);
        for (const result of interactionResults.values())
          yield JSON.stringify(result);
      }
      const initial = pendingReplay();
      const nextInitial = () => {
        if (socket.readyState !== 1) return;
        const next = initial.next();
        if (next.done) return;
        socket.send(next.value, (error) => {
          if (error) socket.terminate();
          else nextInitial();
        });
      };

      socket.send(
        JSON.stringify({
          type: "snapshot",
          protocolVersion: PROTOCOL_VERSION,
          cursor: database.cursor(),
          tasks: database.currentTasks(),
        } satisfies ServerWebSocketMessage),
        (error) => {
          if (error) socket.terminate();
          else nextInitial();
        },
      );
      tracing
        .start("websocket.subscribe", connectionTrace, {
          replayCount: String(replay.length),
        })
        .end();
    });
    socket.on("close", () => {
      clearTimeout(handshake);
      connections.delete(socket);
      subscribers.delete(socket);
      desktopControllers.delete(socket);
      for (const [requestId, pending] of pendingRequests) {
        if (pending.controller === socket && pending.target.readyState === 1)
          sendSocket(
            pending.target,
            JSON.stringify({
              type: "result",
              protocolVersion: PROTOCOL_VERSION,
              requestId,
              threadId: pending.threadId,
              status: "failed",
              error: "工作站连接已断开，结果尚未确认；请核实回合记录",
            }),
          );
        if (pending.target === socket || pending.controller === socket)
          pendingRequests.delete(requestId);
      }
      for (const [requestId, entry] of interactions)
        if (entry.controller === socket) {
          interactions.delete(requestId);
          for (const peer of subscribers)
            if (peer.readyState === 1)
              sendSocket(
                peer,
                JSON.stringify({
                  type: "interaction.result",
                  protocolVersion: PROTOCOL_VERSION,
                  requestId,
                  threadId: entry.request.threadId,
                  status: "expired",
                  error: "工作站连接已断开",
                }),
              );
        }
    });
    socket.on("error", () => {
      subscribers.delete(socket);
      desktopControllers.delete(socket);
    });
  });

  return {
    broadcast,
    get subscriberCount() {
      return subscribers.size;
    },
    close() {
      clearInterval(expiry);
      for (const socket of connections) socket.terminate();
      connections.clear();
      pendingRequests.clear();
      interactions.clear();
      interactionResults.clear();
      subscribers.clear();
      desktopControllers.clear();
    },
  };
}
