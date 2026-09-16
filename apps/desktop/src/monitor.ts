import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  IngestEvent,
  InteractionRequest,
  InteractionResult,
  PlanStep,
  TaskSnapshot,
  TraceContext,
  TraceSpan,
} from "@codex-assistant/protocol";
import {
  IngestEventSchema,
  IngestResponseSchema,
  parseStrict,
  safeTraceSpan,
  type IngestResponse,
} from "@codex-assistant/protocol";
import {
  CodexAppServer,
  type AppServerItem,
  type AppServerPlanStep,
  type AppServerThread,
  type AppServerNotification,
  type AppServerRequest,
} from "./app-server.js";
import WebSocket from "ws";
import {
  createInteraction,
  interactionResponse,
  type PendingInteraction,
} from "./interactions.js";
import {
  deriveTaskStatus,
  fingerprint,
  normalizeAction,
  normalizeActiveFlags,
  normalizeRuntimeStatus,
  normalizeStatus,
  normalizeTurn,
  projectName,
  sanitizeText,
} from "./sanitize.js";
import {
  TraceLogger,
  childTrace,
  newTraceContext,
  traceparent,
} from "./trace.js";

import { LifecycleReader, type Lifecycle } from "./lifecycle.js";
import { CodexDesktopHost } from "./codex-host.js";

type PendingEvent = IngestEvent & { fingerprint: string };
type StoredOutbox = {
  deviceId: string;
  nextSequence: number;
  events: PendingEvent[];
  fingerprints: Record<string, string>;
};
// 只缓存官方基础快照；生命周期投影必须每轮重新计算，不能把推断的 active 写回基础状态。
type CachedTask = { stamp: string; task: TaskSnapshot; lifecycle?: Lifecycle };
export const ACTIVE_EVIDENCE_MAX_AGE_MS = 30 * 60_000;
export const IN_PROGRESS_ITEM_MAX_AGE_MS = 6 * 60 * 60_000;

const MAX_OUTBOX_EVENTS = 5_000;
const MAX_FINGERPRINTS = 10_000;
const RPC_CONCURRENCY = 8;
export const DESKTOP_HOST_UNAVAILABLE_MESSAGE =
  "工作站 Codex Desktop 未连接，请打开并保持 Codex Desktop 运行后重试";
export const DESKTOP_SEND_REJECTED_MESSAGE =
  "Codex Desktop 未接受此消息，请稍后重试";
export const SEND_FAILED_MESSAGE =
  "结果尚未确认，请读取回合摘要核实。消息不会自动重发。";
export type MonitorStatus = "connecting" | "syncing" | "connected" | "offline";
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

type DesktopHost = {
  sendMessage(threadId: string, text: string): Promise<void>;
  close?(): void;
};

function publicSendError(error: unknown): string {
  if (
    error instanceof Error &&
    error.message.startsWith("CODEX_DESKTOP_HOST_UNAVAILABLE")
  )
    return DESKTOP_HOST_UNAVAILABLE_MESSAGE;
  if (
    error instanceof Error &&
    error.message.startsWith("CODEX_DESKTOP_SEND_REJECTED")
  )
    return DESKTOP_SEND_REJECTED_MESSAGE;
  if (
    error instanceof Error &&
    error.message === "CODEX_DESKTOP_HOST_AMBIGUOUS"
  )
    return "检测到多个 Codex Desktop，请只保留目标实例后重试";
  if (
    error instanceof Error &&
    [DESKTOP_HOST_UNAVAILABLE_MESSAGE, DESKTOP_SEND_REJECTED_MESSAGE].includes(
      error.message,
    )
  )
    return error.message;
  if (
    error instanceof Error &&
    error.message === "检测到多个 Codex Desktop，请只保留目标实例后重试"
  )
    return error.message;
  return SEND_FAILED_MESSAGE;
}

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let cursor = 0;
  async function consume(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await worker(values[index]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, values.length) }, () => consume()),
  );
  return results;
}

export class Monitor {
  readonly #server: CodexAppServer;
  readonly #desktopHost: DesktopHost;
  readonly #statePath: string;
  readonly #apiUrl: string;
  readonly #token: string;
  readonly #deviceId: string;
  readonly #traceLogger: TraceLogger;
  #outbox: StoredOutbox;
  #outboxDirty = false;
  #timer?: NodeJS.Timeout;
  #polling = false;
  #pollFinished?: Promise<void>;
  #onTasks: (tasks: TaskSnapshot[]) => void;
  #onStatus: (status: MonitorStatus) => void;
  #lifecycle = new LifecycleReader();
  #threadCache = new Map<string, CachedTask>();
  #inProgressItems = new Map<string, boolean>();
  #nextFlushAt = 0;
  #flushAttempt = 0;
  #traceBuffer: TraceSpan[] = [];
  #traceUpload?: Promise<void>;
  #traceAbort?: AbortController;
  #controlSocket?: WebSocket;
  #controlConnected = false;
  #sendRpcs = new Map<string, Promise<{ status: "started" }>>();
  #interactions = new Map<string, PendingInteraction>();
  #interactionResults = new Map<string, InteractionResult>();
  #stopping = false;

  private constructor(input: {
    statePath: string;
    apiUrl: string;
    token: string;
    deviceId: string;
    outbox: StoredOutbox;
    onTasks: (tasks: TaskSnapshot[]) => void;
    onStatus: (status: MonitorStatus) => void;
    desktopHost?: DesktopHost;
  }) {
    this.#statePath = input.statePath;
    this.#apiUrl = input.apiUrl.replace(/\/$/, "");
    this.#token = input.token;
    this.#deviceId = input.deviceId;
    this.#outbox = input.outbox;
    this.#onTasks = input.onTasks;
    this.#onStatus = input.onStatus;
    this.#desktopHost = input.desktopHost ?? new CodexDesktopHost();
    this.#traceLogger = new TraceLogger(`${input.statePath}.trace.jsonl`);
    this.#server = new CodexAppServer({
      onSpan: (span) => this.#recordSpan(span),
      // app-server stderr 可能包含路径、命令或服务端细节。只记录发生了诊断事件，
      // 不将原始文本写进持久化 trace，避免诊断链路成为数据泄露旁路。
      onLog: () =>
        this.#recordSpan({
          ...newTraceContext(),
          name: "app_server.diagnostic",
          startedAt: new Date().toISOString(),
          endedAt: new Date().toISOString(),
          attributes: { source: "app_server" },
        }),
      onNotification: (notification) => this.#handleNotification(notification),
      onRequest: (request) => this.#handleRequest(request),
      onExit: () => this.#expireInteractions(),
    });
  }

  static async create(options: {
    stateDirectory: string;
    apiUrl: string;
    token: string;
    deviceId: string;
    onTasks: (tasks: TaskSnapshot[]) => void;
    onStatus?: (status: MonitorStatus) => void;
    desktopHost?: DesktopHost;
  }): Promise<Monitor> {
    const path = join(options.stateDirectory, "outbox.json");
    let outbox: StoredOutbox = {
      deviceId: options.deviceId,
      nextSequence: 1,
      events: [],
      fingerprints: {},
    };
    try {
      outbox = JSON.parse(await readFile(path, "utf8")) as StoredOutbox;
    } catch (error) {
      // 保留损坏状态并停止；同设备重置序号为1会与服务器已接收事件冲突。
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new Error("OUTBOX_INVALID");
    }
    if (
      outbox.deviceId !== options.deviceId ||
      !Number.isInteger(outbox.nextSequence) ||
      outbox.nextSequence < 1 ||
      !Array.isArray(outbox.events) ||
      outbox.events.length > MAX_OUTBOX_EVENTS ||
      !outbox.fingerprints ||
      typeof outbox.fingerprints !== "object"
    )
      throw new Error("OUTBOX_INVALID");
    let previousSequence = 0;
    for (const event of outbox.events) {
      if (
        event.deviceId !== options.deviceId ||
        event.localSequence <= previousSequence ||
        event.localSequence >= outbox.nextSequence
      )
        throw new Error("OUTBOX_INVALID");
      previousSequence = event.localSequence;
      const wire = {
        protocolVersion: event.protocolVersion,
        deviceId: event.deviceId,
        localSequence: event.localSequence,
        occurredAt: event.occurredAt,
        trace: event.trace,
        task: event.task,
      };
      if (!parseStrictEvent(wire) || typeof event.fingerprint !== "string")
        throw new Error("OUTBOX_INVALID");
    }
    outbox.fingerprints = Object.assign(
      Object.create(null),
      outbox.fingerprints,
    );
    await mkdir(options.stateDirectory, { recursive: true });
    return new Monitor({
      statePath: path,
      apiUrl: options.apiUrl,
      token: options.token,
      deviceId: options.deviceId,
      outbox,
      onTasks: options.onTasks,
      onStatus: options.onStatus ?? (() => undefined),
      desktopHost: options.desktopHost,
    });
  }

  async start(): Promise<void> {
    this.#onStatus("connecting");
    await this.#server.start();
    this.#connectControl();
    await this.#poll();
    if (!this.#stopping)
      this.#timer = setInterval(() => void this.#poll(), 2_000);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#expireInteractions();
    if (this.#timer) clearInterval(this.#timer);
    this.#traceAbort?.abort();
    await this.#traceUpload;
    await this.#pollFinished;
    await Promise.allSettled([...this.#sendRpcs.values()]);
    this.#desktopHost.close?.();
    await this.#server.stop();
    this.#controlSocket?.close();
    this.#controlSocket = undefined;
    await this.#persist();
    await this.#traceLogger.flush();
  }

  async readDetail(
    threadId: string,
    cursor?: string,
  ): Promise<{ turns: unknown[]; cursor?: string }> {
    await this.#server.start();
    const value = (await this.#server.listTurns(threadId, cursor)) as {
      data?: unknown[];
      nextCursor?: string | null;
    };
    return {
      turns: Array.isArray(value.data) ? value.data : [],
      ...(value.nextCursor ? { cursor: value.nextCursor } : {}),
    };
  }

  get workstationReady(): boolean {
    return this.#server.ready;
  }

  async sendMessage(
    threadId: string,
    text: string,
  ): Promise<{ status: "started" }> {
    if (this.#stopping) throw new Error("MONITOR_STOPPED");
    if (!text.trim() || text.length > 20_000)
      throw new Error("MESSAGE_INVALID");
    const previous = this.#sendRpcs.get(threadId);
    const pending = (async () => {
      await previous?.catch(() => undefined);
      if (this.#stopping) throw new Error("MONITOR_STOPPED");
      // Desktop拥有其会话写入权，手机消息通过其app-tools宿主提交。
      try {
        await this.#desktopHost.sendMessage(threadId, text.trim());
      } catch (error) {
        throw new Error(publicSendError(error));
      }
      return { status: "started" as const };
    })();
    this.#sendRpcs.set(threadId, pending);
    try {
      return await pending;
    } finally {
      if (this.#sendRpcs.get(threadId) === pending)
        this.#sendRpcs.delete(threadId);
    }
  }
  get interactions(): InteractionRequest[] {
    return [...this.#interactions.values()].map((p) => p.request);
  }

  submitInteraction(
    requestId: string,
    threadId: string,
    value: unknown,
  ): InteractionResult {
    const done = this.#interactionResults.get(requestId);
    if (done?.threadId === threadId) {
      this.#sendControl(done);
      return done;
    }
    const pending = this.#interactions.get(requestId);
    const result: {
      -readonly [K in keyof InteractionResult]: InteractionResult[K];
    } = {
      type: "interaction.result",
      protocolVersion: "codex-assistant.v3",
      requestId,
      threadId,
      status: "expired",
    };
    if (!pending || pending.request.threadId !== threadId) return result;
    try {
      const official = interactionResponse(pending, value);
      if (official.unsupported)
        this.#server.respondError(
          pending.rpc.id,
          -32601,
          "Request cancelled: unsupported by this client",
        );
      else this.#server.respond(pending.rpc.id, official.result);
      result.status = official.cancel ? "cancelled" : "submitted";
      this.#interactions.delete(requestId);
      this.#interactionResults.set(requestId, result);
      if (this.#interactionResults.size > 1000)
        this.#interactionResults.delete(
          this.#interactionResults.keys().next().value!,
        );
    } catch {
      result.status = "failed";
      result.error =
        "回答不完整、不符合请求约束，或 Codex 连接不可用；请核实后重试";
    }
    this.#sendControl(result);
    return result;
  }

  #sendControl(message: unknown): void {
    if (
      this.#controlConnected &&
      this.#controlSocket?.readyState === WebSocket.OPEN
    )
      this.#controlSocket.send(JSON.stringify(message));
  }

  #expireInteractions(threadId?: string, rpcId?: unknown): void {
    for (const [id, pending] of this.#interactions) {
      if (threadId && pending.request.threadId !== threadId) continue;
      if (rpcId !== undefined && pending.rpc.id !== rpcId) continue;
      this.#interactions.delete(id);
      this.#sendControl({
        type: "interaction.result",
        protocolVersion: "codex-assistant.v3",
        requestId: id,
        threadId: pending.request.threadId,
        status: "expired",
      });
    }
  }

  #connectControl(): void {
    if (this.#controlSocket) return;
    const url =
      this.#apiUrl.replace(/^http/, "ws") + "/codex-assistant/api/v3/stream";
    const socket = new WebSocket(url);
    this.#controlSocket = socket;
    socket.on("open", () => {
      socket.send(
        JSON.stringify({
          type: "auth",
          protocolVersion: "codex-assistant.v3",
          token: this.#token,
        }),
      );
    });
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw)) as Record<string, unknown>;
        if (message.type === "authenticated") {
          socket.send(
            JSON.stringify({
              type: "subscribe",
              protocolVersion: "codex-assistant.v3",
              after: 0,
            }),
          );
          socket.send(
            JSON.stringify({
              type: "role",
              protocolVersion: "codex-assistant.v3",
              role: "desktop",
            }),
          );
          this.#controlConnected = true;
          for (const pending of this.#interactions.values())
            this.#sendControl(pending.request);
          return;
        }
        if (
          message.type === "send" &&
          typeof message.requestId === "string" &&
          typeof message.threadId === "string" &&
          typeof message.text === "string"
        ) {
          void this.sendMessage(message.threadId, message.text)
            .then(() => {
              if (socket.readyState !== WebSocket.OPEN) return;
              socket.send(
                JSON.stringify({
                  type: "result",
                  protocolVersion: "codex-assistant.v3",
                  requestId: message.requestId,
                  threadId: message.threadId,
                  status: "started",
                }),
              );
            })
            .catch((error: unknown) => {
              if (socket.readyState !== WebSocket.OPEN) return;
              socket.send(
                JSON.stringify({
                  type: "result",
                  protocolVersion: "codex-assistant.v3",
                  requestId: message.requestId,
                  threadId: message.threadId,
                  status: "failed",
                  error: publicSendError(error),
                }),
              );
            });
          return;
        }
        if (
          message.type === "detail" &&
          typeof message.requestId === "string" &&
          typeof message.threadId === "string"
        ) {
          void this.readDetail(
            message.threadId,
            typeof message.cursor === "string" ? message.cursor : undefined,
          )
            .then((detail) =>
              socket.send(
                JSON.stringify({
                  type: "detail",
                  protocolVersion: "codex-assistant.v3",
                  requestId: message.requestId,
                  threadId: message.threadId,
                  turns: detail.turns,
                  ...(detail.cursor ? { cursor: detail.cursor } : {}),
                }),
              ),
            )
            .catch((error: unknown) =>
              socket.send(
                JSON.stringify({
                  type: "result",
                  protocolVersion: "codex-assistant.v3",
                  requestId: message.requestId,
                  threadId: message.threadId,
                  status: "failed",
                  error:
                    error instanceof Error
                      ? error.message.slice(0, 500)
                      : "DETAIL_FAILED",
                }),
              ),
            );
        }
        if (
          message.type === "interaction.submit" &&
          typeof message.requestId === "string" &&
          typeof message.threadId === "string"
        ) {
          this.submitInteraction(
            message.requestId,
            message.threadId,
            message.value,
          );
        }
      } catch {
        /* invalid control frames are ignored */
      }
    });
    socket.on("close", () => {
      if (this.#controlSocket === socket) {
        this.#controlSocket = undefined;
        this.#controlConnected = false;
      }
    });
    socket.on("error", () => undefined);
  }

  #handleRequest(request: AppServerRequest): void {
    const pending = createInteraction(request);
    if (!pending) {
      this.#server.respondError(
        request.id,
        -32601,
        "Unsupported request without thread context",
      );
      return;
    }
    this.#interactions.set(pending.request.requestId, pending);
    this.#sendControl(pending.request);
  }

  #handleNotification(notification: AppServerNotification): void {
    const params = notification.params;
    const threadId =
      typeof params.threadId === "string" ? params.threadId : undefined;
    if (notification.method === "serverRequest/resolved") {
      this.#expireInteractions(threadId, params.requestId);
      return;
    }
    const terminal = notification.method === "turn/completed";
    if (!threadId) return;
    if (terminal) this.#expireInteractions(threadId);
    // Desktop回执没有真实回合标识，独立app-server通知不能完成本次发送。
  }

  async #poll(): Promise<void> {
    if (this.#polling || this.#stopping) return;
    this.#connectControl();
    this.#polling = true;
    let finish!: () => void;
    this.#pollFinished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.#onStatus("syncing");
    const trace = newTraceContext();
    const startedAt = performance.now();
    this.#server.setTraceContext(trace);
    try {
      await this.#server.start();
      const threads = await this.#server.listThreads();
      const seen = new Set(threads.map((thread) => thread.id));
      this.#lifecycle.retain(seen);
      for (const id of this.#threadCache.keys())
        if (!seen.has(id)) {
          this.#threadCache.delete(id);
          this.#inProgressItems.delete(id);
        }
      const pendingIds = new Set(
        this.#outbox.events.map((event) => event.task.id),
      );
      for (const id of Object.keys(this.#outbox.fingerprints))
        if (!seen.has(id) && !pendingIds.has(id))
          delete this.#outbox.fingerprints[id];
      const fingerprints = Object.keys(this.#outbox.fingerprints);
      for (const id of fingerprints.slice(
        0,
        Math.max(0, fingerprints.length - MAX_FINGERPRINTS),
      ))
        delete this.#outbox.fingerprints[id];
      let tasks = await mapLimit(threads, RPC_CONCURRENCY, async (thread) => {
        try {
          return await this.#normalizeCached(thread);
        } catch {
          return this.#staleTask(thread);
        }
      });
      tasks = tasks.map((task) =>
        this.interactions.some((r) => r.threadId === task.id)
          ? { ...task, status: "needs_action" }
          : task,
      );
      this.#onTasks(tasks);
      // 队列满时先尝试排出已保存事件，否则“入队报满→跳过发送”会形成永久死锁。
      if (this.#outbox.events.length >= MAX_OUTBOX_EVENTS) await this.#flush();
      // 同轮变更先原子落盘，再开始网络请求；失败不会越过持久化边界。
      let changed = false;
      try {
        for (const task of tasks)
          changed = this.#enqueue(task, trace) || changed;
      } finally {
        if (changed) await this.#persist();
      }
      await this.#flush();
      this.#recordSpan(
        this.#span(trace, "desktop.poll", startedAt, {
          threads: String(threads.length),
          tasks: String(tasks.length),
          outbox: String(this.#outbox.events.length),
        }),
      );
      this.#startTraceUpload();
      this.#onStatus("connected");
    } catch (error) {
      this.#recordSpan(
        this.#span(trace, "desktop.poll.error", startedAt, {
          error: "POLL_FAILED",
        }),
      );
      this.#onStatus("offline");
    } finally {
      this.#server.setTraceContext(undefined);
      this.#polling = false;
      finish();
      this.#pollFinished = undefined;
    }
  }

  #span(
    parent: TraceContext,
    name: string,
    startedAt: number,
    attributes: Record<string, string>,
  ): TraceSpan {
    // 调用方在操作开始时确定ID；同一个上下文同时用于HTTP传播和最终span。
    const context = parent;
    return {
      ...context,
      name,
      startedAt: new Date(
        Date.now() - Math.max(0, performance.now() - startedAt),
      ).toISOString(),
      endedAt: new Date().toISOString(),
      attributes,
    };
  }

  async #normalizeCached(thread: AppServerThread): Promise<TaskSnapshot> {
    const lifecycle = await this.#lifecycle.read(thread.id, thread.path);
    const stamp = JSON.stringify([
      thread.updatedAt,
      thread.status,
      thread.name,
      thread.preview,
      this.#server.planRevision(thread.id),
      this.#server.latestTurn(thread.id),
    ]);
    const cached = this.#threadCache.get(thread.id);
    if (cached?.stamp === stamp) {
      cached.lifecycle = lifecycle;
      return applyLifecycle(
        cached.task,
        lifecycle,
        Date.now(),
        this.#inProgressItems.get(thread.id) === true,
      );
    }
    const task = await this.#normalize(thread, lifecycle);
    const entry: CachedTask = { stamp, task, lifecycle };
    this.#threadCache.set(thread.id, entry);
    return applyLifecycle(
      task,
      lifecycle,
      Date.now(),
      this.#inProgressItems.get(thread.id) === true,
    );
  }

  #staleTask(thread: AppServerThread): TaskSnapshot {
    const updatedAt = this.#timestamp(thread.updatedAt);
    const runtimeStatus = normalizeRuntimeStatus(thread.status);
    const activeFlags = normalizeActiveFlags(thread.status);
    const entry = this.#threadCache.get(thread.id);
    // 文件暂不可读时仍重新检查旧证据的有效期，不能借错误路径永久冻结 active。
    const cached = entry
      ? applyLifecycle(
          entry.task,
          entry.lifecycle,
          Date.now(),
          this.#inProgressItems.get(thread.id) === true,
        )
      : undefined;
    // 读取失败不意味着任务发生了变化：缓存的来源时间必须与缓存内容一起保留。
    if (cached)
      return {
        ...cached,
        freshness: "stale",
        error:
          cached.error?.code === "ACTIVE_EVIDENCE_EXPIRED"
            ? cached.error
            : {
                code: "DETAIL_UNAVAILABLE",
                message: "线程详情暂时不可用，显示最近一次状态",
              },
      };
    return {
      id: thread.id,
      title: sanitizeText(thread.name || thread.preview || thread.id),
      ...(projectName(thread.cwd)
        ? { projectName: projectName(thread.cwd) }
        : {}),
      status: deriveTaskStatus(
        undefined,
        runtimeStatus,
        activeFlags,
        undefined,
      ),
      runtimeStatus,
      activeFlags,
      freshness: "unavailable",
      source: "thread",
      plan: [],
      updatedAt,
      changedAt: updatedAt,
      error: { code: "DETAIL_UNAVAILABLE", message: "线程详情暂时不可用" },
    };
  }

  async #normalize(
    thread: AppServerThread,
    lifecycle?: Lifecycle,
  ): Promise<TaskSnapshot> {
    const [read, goal, turns, items] = await Promise.all([
      this.#server.readThread(thread.id),
      this.#server.getGoal(thread.id),
      this.#server.listTurns(thread.id),
      this.#server.listItems(thread.id),
    ]);
    const loaded = asRecord(read).thread;
    const currentThread =
      loaded && typeof loaded === "object"
        ? { ...(loaded as AppServerThread), ...thread }
        : thread;
    const goalData =
      goal && typeof goal === "object"
        ? (goal as Record<string, unknown>)
        : undefined;
    const turnRows = asRecord(turns).data ?? turns;
    const latestTurn =
      normalizeTurn(this.#server.latestTurn(thread.id)) ??
      (Array.isArray(turnRows) ? normalizeTurn(turnRows[0]) : undefined);
    const runtimeStatus = normalizeRuntimeStatus(currentThread.status);
    const activeFlags = normalizeActiveFlags(currentThread.status);
    const goalStatus =
      typeof goalData?.status === "string"
        ? normalizeStatus(goalData.status)
        : undefined;
    const title = sanitizeText(
      goalData?.objective ||
        currentThread.name ||
        currentThread.preview ||
        currentThread.id,
    );
    const plan = this.#plan(turns, items, this.#server.planFor(thread.id));
    const currentStep =
      plan.find((step) => step.status === "in_progress") ??
      plan.find((step) => step.status === "pending");
    const itemList = this.#items(items);
    this.#inProgressItems.set(
      currentThread.id,
      this.#hasInProgressItem(items, lifecycle),
    );
    const latestAction =
      itemList.find((item) => item.status === "inProgress")?.type ??
      itemList[0]?.type;
    const updatedAt = this.#timestamp(currentThread.updatedAt);
    const status = deriveTaskStatus(
      goalStatus,
      runtimeStatus,
      activeFlags,
      latestTurn,
    );
    const error = latestTurn?.error;
    return {
      id: currentThread.id,
      title,
      ...(projectName(currentThread.cwd)
        ? { projectName: projectName(currentThread.cwd) }
        : {}),
      status,
      runtimeStatus,
      activeFlags,
      freshness: "fresh",
      source: goalStatus ? "goal" : "thread",
      ...(goalStatus
        ? {
            goal: {
              objective: sanitizeText(goalData?.objective),
              status: goalStatus,
              timeUsedSeconds: Number.isFinite(goalData?.timeUsedSeconds)
                ? Math.max(0, Math.trunc(Number(goalData?.timeUsedSeconds)))
                : 0,
              tokensUsed: Number.isFinite(goalData?.tokensUsed)
                ? Math.max(0, Math.trunc(Number(goalData?.tokensUsed)))
                : 0,
              ...(Number.isFinite(goalData?.tokenBudget)
                ? {
                    tokenBudget: Math.max(
                      0,
                      Math.trunc(Number(goalData?.tokenBudget)),
                    ),
                  }
                : {}),
            },
          }
        : {}),
      ...(latestTurn ? { latestTurn } : {}),
      ...(error ? { error } : {}),
      plan,
      ...(currentStep ? { currentStepId: currentStep.id } : {}),
      ...(latestAction && normalizeAction(latestAction)
        ? { action: normalizeAction(latestAction) }
        : {}),
      updatedAt,
      changedAt: updatedAt,
    };
  }

  #timestamp(value: unknown): string {
    if (typeof value === "number" && Number.isFinite(value))
      return new Date(
        value > 10_000_000_000 ? value : value * 1000,
      ).toISOString();
    if (typeof value === "string" && !Number.isNaN(Date.parse(value)))
      return new Date(value).toISOString();
    return new Date().toISOString();
  }

  #plan(
    turnsValue: unknown,
    itemsValue: unknown,
    notifiedPlan?: AppServerPlanStep[],
  ): PlanStep[] {
    if (notifiedPlan?.length) return this.#planRows(notifiedPlan);
    const turnRows = asRecord(turnsValue).data ?? turnsValue;
    const externalItems = this.#items(itemsValue);
    const turnItems = Array.isArray(turnRows)
      ? turnRows.flatMap((turn) => {
          const items = asRecord(turn).items;
          return Array.isArray(items)
            ? items.map((item) => asRecord(item))
            : [];
        })
      : [];
    const planItems = [...turnItems, ...externalItems].filter(
      (item) => item.type === "plan",
    );
    const latest = planItems[0];
    if (latest && typeof latest.text === "string") {
      try {
        const parsed = JSON.parse(latest.text) as unknown;
        if (Array.isArray(parsed)) return this.#planRows(parsed);
      } catch {
        /* 明文计划继续按行解析 */
      }
      const lines = latest.text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      const parsed = lines.map((line, index) => ({
        id: `step-${index + 1}`,
        title: line.replace(/^[-*]\s*(?:\[[ xX]\]\s*)?/, ""),
        status: /\[[xX]\]|complete|done/i.test(line) ? "completed" : "pending",
      }));
      if (parsed.length) return this.#planRows(parsed);
    }
    return [];
  }

  #planRows(value: unknown[]): PlanStep[] {
    return value.slice(0, 100).map((row, index) => {
      const item = asRecord(row);
      const rawStatus = String(item.status ?? "pending");
      const status: PlanStep["status"] = /complete|done/i.test(rawStatus)
        ? "completed"
        : /progress|running|active/i.test(rawStatus)
          ? "in_progress"
          : /fail|error/i.test(rawStatus)
            ? "failed"
            : "pending";
      return {
        id: sanitizeText(item.id ?? `step-${index + 1}`, 200),
        title: sanitizeText(
          item.title ?? item.name ?? item.step ?? `Step ${index + 1}`,
        ),
        status,
      };
    });
  }

  #items(value: unknown): AppServerItem[] {
    const rows = asRecord(value).data ?? value;
    return Array.isArray(rows)
      ? rows
          .map((row) => {
            const record = asRecord(row);
            return (
              record.item && typeof record.item === "object"
                ? record.item
                : record
            ) as AppServerItem;
          })
          .slice(0, 100)
      : [];
  }

  #hasInProgressItem(value: unknown, lifecycle?: Lifecycle): boolean {
    if (!lifecycle || lifecycle.turn.status !== "inProgress") return false;
    const rows = asRecord(value).data ?? value;
    if (!Array.isArray(rows)) return false;
    return rows.some((row) => {
      const entry = asRecord(row);
      if (typeof entry.turnId === "string" && entry.turnId !== lifecycle.turnId)
        return false;
      const item = asRecord(entry.item ?? entry);
      return item.status === "inProgress";
    });
  }

  #enqueue(task: TaskSnapshot, parent: TraceContext): boolean {
    const nextFingerprint = fingerprint(task);
    if (this.#outbox.fingerprints[task.id] === nextFingerprint) return false;
    if (this.#outbox.events.length >= MAX_OUTBOX_EVENTS)
      throw new Error("OUTBOX_LIMIT");
    const trace = childTrace(parent);
    const now = new Date().toISOString();
    this.#recordSpan({
      ...trace,
      name: "desktop.event",
      startedAt: now,
      endedAt: now,
      attributes: { taskId: task.id },
    });
    this.#outbox.fingerprints[task.id] = nextFingerprint;
    this.#outbox.events.push({
      protocolVersion: "codex-assistant.v3",
      deviceId: this.#deviceId,
      localSequence: this.#outbox.nextSequence++,
      occurredAt: new Date().toISOString(),
      trace,
      task,
      fingerprint: nextFingerprint,
    });
    this.#outboxDirty = true;
    return true;
  }

  async #flush(): Promise<void> {
    // 上轮落盘失败时必须先重试写入，不能凭内存指纹跳过持久化直接发送。
    if (this.#outboxDirty) await this.#persist();
    if (Date.now() < this.#nextFlushAt) return;
    const deadline = performance.now() + 1000;
    let acknowledged = 0;
    try {
      // 一次最多 100 条/约一秒，单个在途请求仍受 10 秒超时约束。
      while (
        !this.#stopping &&
        this.#outbox.events.length &&
        acknowledged < 100 &&
        performance.now() < deadline
      ) {
        const event = this.#outbox.events[0];
        const { fingerprint: _fingerprint, ...wireEvent } = event;
        const uploadTrace = childTrace(event.trace);
        const startedAt = performance.now();
        try {
          const response = await fetch(
            `${this.#apiUrl}/codex-assistant/api/v3/events`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${this.#token}`,
                "content-type": "application/json",
                traceparent: traceparent(uploadTrace),
              },
              body: JSON.stringify(wireEvent),
              signal: AbortSignal.timeout(10_000),
            },
          );
          if (!response.ok) throw new Error("UPLOAD_HTTP_FAILED");
          const receipt = parseStrict<IngestResponse>(
            IngestResponseSchema,
            await response.json(),
          );
          if (!receipt?.accepted) throw new Error("INGEST_RECEIPT_INVALID");
          this.#outbox.events.shift();
          this.#outboxDirty = true;
          this.#flushAttempt = 0;
          this.#nextFlushAt = 0;
          acknowledged++;
          this.#recordSpan(
            this.#span(uploadTrace, "desktop.upload", startedAt, {
              status: String(response.status),
              latencyMs: String(Math.trunc(performance.now() - startedAt)),
            }),
          );
        } catch (error) {
          this.#recordSpan(
            this.#span(uploadTrace, "desktop.upload.error", startedAt, {
              error: "UPLOAD_FAILED",
            }),
          );
          this.#scheduleRetry();
          return;
        }
      }
    } finally {
      // 崩溃前尚未落盘的确认会重发，服务器按设备和序号去重，不丢业务事件。
      if (acknowledged) await this.#persist();
    }
  }

  #scheduleRetry(): void {
    this.#flushAttempt = Math.min(this.#flushAttempt + 1, 6);
    this.#nextFlushAt =
      Date.now() + Math.min(60_000, 1_000 * 2 ** (this.#flushAttempt - 1));
  }

  async #persist(): Promise<void> {
    const temporary = `${this.#statePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#outbox)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporary, this.#statePath);
    await rm(temporary, { force: true });
    this.#outboxDirty = false;
  }

  #recordSpan(span: TraceSpan): void {
    const safe = safeTraceSpan(span);
    this.#traceLogger.record(safe);
    this.#traceBuffer.push(safe);
    if (this.#traceBuffer.length > 100)
      this.#traceBuffer.splice(0, this.#traceBuffer.length - 100);
  }

  #startTraceUpload(): void {
    if (this.#stopping || this.#traceUpload) return;
    this.#traceAbort = new AbortController();
    this.#traceUpload = this.#flushTraceBuffer().finally(() => {
      this.#traceUpload = undefined;
      this.#traceAbort = undefined;
    });
  }

  async #flushTraceBuffer(): Promise<void> {
    if (!this.#traceBuffer.length) return;
    const spans = this.#traceBuffer.slice(0, 100);
    try {
      const response = await fetch(
        `${this.#apiUrl}/codex-assistant/api/v3/traces/spans`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.#token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            protocolVersion: "codex-assistant.v3",
            spans,
          }),
          signal: AbortSignal.any([
            AbortSignal.timeout(5_000),
            this.#traceAbort!.signal,
          ]),
        },
      );
      if (response.ok) {
        const acknowledged = new Set(spans.map((span) => span.spanId));
        this.#traceBuffer = this.#traceBuffer.filter(
          (span) => !acknowledged.has(span.spanId),
        );
      }
    } catch {
      // Trace 是有界诊断缓存；上传失败不阻塞任务同步，也不保证永不丢失。
    }
  }
}

function parseStrictEvent(value: unknown): IngestEvent | undefined {
  // TypeBox schema 校验放在恢复路径，损坏 outbox 直接停机而不是静默丢事件。
  return parseStrict(IngestEventSchema, value) as IngestEvent | undefined;
}

export function deviceIdFromInstall(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 32);
}

/** 保留独立 RPC 的官方运行态；本机生命周期只修正最近回合，不能伪造 active flags。 */
export function applyLifecycle(
  task: TaskSnapshot,
  lifecycle?: Lifecycle,
  now = Date.now(),
  hasInProgressItem = false,
): TaskSnapshot {
  if (task.runtimeStatus !== "notLoaded") return task;
  if (!lifecycle) {
    if (task.status !== "running") return task;
    return {
      ...task,
      status: "needs_action",
      freshness: "unavailable",
      error: {
        code: "ACTIVE_EVIDENCE_UNAVAILABLE",
        message: "无有效运行证据，状态待确认",
      },
    };
  }
  const { error: _error, ...base } = task;
  const latestTurn = lifecycle.turn;
  const evidenceTime = Date.parse(lifecycle.evidenceAt);
  const updatedAt =
    Date.parse(task.updatedAt) > Date.parse(lifecycle.updatedAt)
      ? task.updatedAt
      : lifecycle.updatedAt;
  // 对话或元数据继续更新不应改变“进入当前回合状态”的时间。Goal 优先时保留 Goal 的时间。
  const changedAt = task.goal ? task.changedAt : lifecycle.updatedAt;
  // 文件写入时间只是一种有界活动证据，不是进程存活证明。容许文件时钟的亚秒精度差，
  // 超过一秒的未来时间视为异常，不能无限续期。
  // 明确的完成/中止事件不需要续期；Goal 的暂停、阻塞、完成等仍保留原有优先级。
  const evidenceAge = now - evidenceTime;
  if (
    latestTurn.status === "inProgress" &&
    hasInProgressItem &&
    Number.isFinite(evidenceTime) &&
    evidenceTime <= now + 1_000 &&
    evidenceAge < IN_PROGRESS_ITEM_MAX_AGE_MS
  ) {
    const status = deriveTaskStatus(
      task.goal?.status,
      task.runtimeStatus,
      task.activeFlags,
      latestTurn,
    );
    return {
      ...base,
      latestTurn,
      status,
      updatedAt,
      changedAt,
      freshness: evidenceAge < ACTIVE_EVIDENCE_MAX_AGE_MS ? "fresh" : "stale",
    };
  }
  if (
    latestTurn.status === "inProgress" &&
    (!Number.isFinite(evidenceTime) ||
      evidenceTime > now + 1_000 ||
      now - evidenceTime >= ACTIVE_EVIDENCE_MAX_AGE_MS)
  ) {
    const status = "needs_action";
    return {
      ...base,
      latestTurn,
      status,
      updatedAt,
      changedAt,
      freshness: "stale",
      error: {
        code: "ACTIVE_EVIDENCE_EXPIRED",
        message: "近期无有效运行证据，运行状态待确认；未判定为完成或失败",
      },
    };
  }
  return {
    ...base,
    latestTurn,
    status: deriveTaskStatus(
      task.goal?.status,
      task.runtimeStatus,
      task.activeFlags,
      latestTurn,
    ),
    ...(latestTurn.error ? { error: latestTurn.error } : {}),
    updatedAt,
    changedAt,
  };
}
