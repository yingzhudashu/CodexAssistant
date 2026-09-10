import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IngestEvent, InteractionRequest, InteractionResult, PlanStep, TaskSnapshot, TraceContext, TraceSpan } from "@codex-assistant/protocol";
import { IngestEventSchema, parseStrict } from "@codex-assistant/protocol";
import { CodexAppServer, type AppServerItem, type AppServerPlanStep, type AppServerThread, type AppServerNotification, type AppServerRequest } from "./app-server.js";
import WebSocket from "ws";
import { createInteraction, interactionResponse, type PendingInteraction } from "./interactions.js";
import { deriveTaskStatus, fingerprint, normalizeAction, normalizeActiveFlags, normalizeRuntimeStatus, normalizeStatus, normalizeTurn, projectName, sanitizeText } from "./sanitize.js";
import { TraceLogger, childTrace, newTraceContext, traceparent } from "./trace.js";

import { LifecycleReader, type Lifecycle } from "./lifecycle.js";

type PendingEvent = IngestEvent & { fingerprint: string };
type StoredOutbox = { deviceId: string; nextSequence: number; events: PendingEvent[]; fingerprints: Record<string, string> };
// 只缓存官方基础快照；生命周期投影必须每轮重新计算，不能把推断的 active 写回基础状态。
type CachedTask = { stamp: string; task: TaskSnapshot; lifecycle?: Lifecycle };
export const ACTIVE_EVIDENCE_MAX_AGE_MS = 30 * 60_000;
export const IN_PROGRESS_ITEM_MAX_AGE_MS = 6 * 60 * 60_000;

const MAX_OUTBOX_EVENTS = 5_000;
const MAX_FINGERPRINTS = 10_000;
const RPC_CONCURRENCY = 8;
export type MonitorStatus = "connecting" | "syncing" | "connected" | "offline";
const asRecord = (value: unknown): Record<string, unknown> => value && typeof value === "object" ? value as Record<string, unknown> : {};

async function mapLimit<T, R>(values: T[], limit: number, worker: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(values.length);
  let cursor = 0;
  async function consume(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= values.length) return;
      results[index] = await worker(values[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => consume()));
  return results;
}

export class Monitor {
  readonly #server: CodexAppServer;
  readonly #statePath: string;
  readonly #apiUrl: string;
  readonly #token: string;
  readonly #deviceId: string;
  readonly #traceLogger: TraceLogger;
  #outbox: StoredOutbox;
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
  #controlSocket?: WebSocket;
  #controlConnected = false;
  #pendingControl = new Map<string, { threadId: string; turnId?: string }>();
  #sendRpcs = new Map<string, Promise<{ status: string; turnId?: string }>>();
  #interactions = new Map<string, PendingInteraction>();
  #interactionResults = new Map<string, InteractionResult>();
  #stopping = false;

  private constructor(input: { statePath: string; apiUrl: string; token: string; deviceId: string; outbox: StoredOutbox; onTasks: (tasks: TaskSnapshot[]) => void; onStatus: (status: MonitorStatus) => void }) {
    this.#statePath = input.statePath;
    this.#apiUrl = input.apiUrl.replace(/\/$/, "");
    this.#token = input.token;
    this.#deviceId = input.deviceId;
    this.#outbox = input.outbox;
    this.#onTasks = input.onTasks;
    this.#onStatus = input.onStatus;
    this.#traceLogger = new TraceLogger(`${input.statePath}.trace.jsonl`);
    this.#server = new CodexAppServer({
      onSpan: (span) => this.#recordSpan(span),
      // app-server stderr 可能包含路径、命令或服务端细节。只记录发生了诊断事件，
      // 不将原始文本写进持久化 trace，避免诊断链路成为数据泄露旁路。
      onLog: () => this.#recordSpan({ ...newTraceContext(), name: "app_server.diagnostic", startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), attributes: { source: "app_server" } }),
      onNotification: (notification) => this.#handleNotification(notification),
      onRequest: (request) => this.#handleRequest(request),
      onExit: () => this.#expireInteractions(),
    });
  }

  static async create(options: { stateDirectory: string; apiUrl: string; token: string; deviceId: string; onTasks: (tasks: TaskSnapshot[]) => void; onStatus?: (status: MonitorStatus) => void }): Promise<Monitor> {
    const path = join(options.stateDirectory, "outbox.json");
    let outbox: StoredOutbox = { deviceId: options.deviceId, nextSequence: 1, events: [], fingerprints: {} };
    try { outbox = JSON.parse(await readFile(path, "utf8")) as StoredOutbox; }
    catch (error) {
      // Preserve corrupt state and stop: resetting sequence 1 for the same
      // device would collide with already accepted events.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("OUTBOX_INVALID");
    }
    if (outbox.deviceId !== options.deviceId || !Number.isInteger(outbox.nextSequence) || outbox.nextSequence < 1 || !Array.isArray(outbox.events) || outbox.events.length > MAX_OUTBOX_EVENTS || !outbox.fingerprints || typeof outbox.fingerprints !== "object") throw new Error("OUTBOX_INVALID");
    let previousSequence = 0;
    for (const event of outbox.events) {
      if (event.deviceId !== options.deviceId || event.localSequence <= previousSequence || event.localSequence >= outbox.nextSequence) throw new Error("OUTBOX_INVALID");
      previousSequence = event.localSequence;
      const wire = { protocolVersion: event.protocolVersion, deviceId: event.deviceId, localSequence: event.localSequence, occurredAt: event.occurredAt, trace: event.trace, task: event.task };
      if (!parseStrictEvent(wire) || typeof event.fingerprint !== "string") throw new Error("OUTBOX_INVALID");
    }
    await mkdir(options.stateDirectory, { recursive: true });
    return new Monitor({ statePath: path, apiUrl: options.apiUrl, token: options.token, deviceId: options.deviceId, outbox, onTasks: options.onTasks, onStatus: options.onStatus ?? (() => undefined) });
  }

  async start(): Promise<void> {
    this.#onStatus("connecting");
    await this.#server.start();
    this.#connectControl();
    await this.#poll();
    if (!this.#stopping) this.#timer = setInterval(() => void this.#poll(), 2_000);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    this.#expireInteractions();
    if (this.#timer) clearInterval(this.#timer);
    await this.#pollFinished;
    await Promise.allSettled([...this.#sendRpcs.values()]);
    await this.#server.stop();
    this.#controlSocket?.close();
    this.#controlSocket = undefined;
    await this.#persist();
    await this.#traceLogger.flush();
  }

  async readDetail(threadId: string, cursor?: string): Promise<{ turns: unknown[]; cursor?: string }> {
    await this.#server.start();
    const value = await this.#server.listTurns(threadId, cursor) as { data?: unknown[]; nextCursor?: string | null };
    return { turns: Array.isArray(value.data) ? value.data : [], ...(value.nextCursor ? { cursor: value.nextCursor } : {}) };
  }

  get workstationReady(): boolean { return this.#server.ready; }

  async sendMessage(threadId: string, text: string): Promise<{ status: string; turnId?: string }> {
    if (this.#stopping) throw new Error("MONITOR_STOPPED");
    if (!text.trim() || text.length > 20_000) throw new Error("MESSAGE_INVALID");
    const previous = this.#sendRpcs.get(threadId);
    const pending = (async () => {
      await previous?.catch(() => undefined);
      if (this.#stopping) throw new Error("MONITOR_STOPPED");
      await this.#server.start();
      await this.#server.resumeThread(threadId);
      const current = this.#server.latestTurn(threadId) as { id?: string; status?: string } | undefined;
      const response = asRecord(current?.id && current.status === "inProgress"
        ? await this.#server.steerTurn(threadId, current.id, text.trim())
        : await this.#server.startTurn(threadId, text.trim()));
      const turnId = asRecord(response.turn).id ?? response.turnId ?? current?.id;
      return { status: "started", ...(typeof turnId === "string" ? { turnId } : {}) };
    })();
    this.#sendRpcs.set(threadId, pending);
    try { return await pending; } finally { if (this.#sendRpcs.get(threadId) === pending) this.#sendRpcs.delete(threadId); }
  }

  get interactions(): InteractionRequest[] { return [...this.#interactions.values()].map(p => p.request); }

  submitInteraction(requestId: string, threadId: string, value: unknown): InteractionResult {
    const done = this.#interactionResults.get(requestId);
    if (done?.threadId === threadId) { this.#sendControl(done); return done; }
    const pending = this.#interactions.get(requestId);
    const result: { -readonly [K in keyof InteractionResult]: InteractionResult[K] } = { type: "interaction.result", protocolVersion: "codex-assistant.v3", requestId, threadId, status: "expired" };
    if (!pending || pending.request.threadId !== threadId) return result;
    try {
      const official = interactionResponse(pending, value);
      if (official.unsupported) this.#server.respondError(pending.rpc.id, -32601, "Request cancelled: unsupported by this client");
      else this.#server.respond(pending.rpc.id, official.result);
      result.status = official.cancel ? "cancelled" : "submitted";
      this.#interactions.delete(requestId);
      this.#interactionResults.set(requestId, result);
      if (this.#interactionResults.size > 1000) this.#interactionResults.delete(this.#interactionResults.keys().next().value!);
    } catch {
      result.status = "failed";
      result.error = "回答不完整、不符合请求约束，或 Codex 连接不可用；请核实后重试";
    }
    this.#sendControl(result);
    return result;
  }

  #sendControl(message: unknown): void {
    if (this.#controlConnected && this.#controlSocket?.readyState === WebSocket.OPEN) this.#controlSocket.send(JSON.stringify(message));
  }

  #expireInteractions(threadId?: string, rpcId?: unknown): void {
    for (const [id, pending] of this.#interactions) {
      if (threadId && pending.request.threadId !== threadId) continue;
      if (rpcId !== undefined && pending.rpc.id !== rpcId) continue;
      this.#interactions.delete(id);
      this.#sendControl({ type: "interaction.result", protocolVersion: "codex-assistant.v3", requestId: id, threadId: pending.request.threadId, status: "expired" });
    }
  }

  #connectControl(): void {
    if (this.#controlSocket) return;
    const url = this.#apiUrl.replace(/^http/, "ws") + "/codex-assistant/api/v3/stream";
    const socket = new WebSocket(url);
    this.#controlSocket = socket;
    socket.on("open", () => { socket.send(JSON.stringify({ type: "auth", protocolVersion: "codex-assistant.v3", token: this.#token })); });
    socket.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw)) as Record<string, unknown>;
        if (message.type === "authenticated") { socket.send(JSON.stringify({ type: "subscribe", protocolVersion: "codex-assistant.v3", after: 0 })); socket.send(JSON.stringify({ type: "role", role: "desktop" })); this.#controlConnected = true; for (const pending of this.#interactions.values()) this.#sendControl(pending.request); return; }
        if (message.type === "send" && typeof message.requestId === "string" && typeof message.threadId === "string" && typeof message.text === "string") {
          this.#pendingControl.set(message.requestId, { threadId: message.threadId });
          void this.sendMessage(message.threadId, message.text).then((accepted) => { const pending = this.#pendingControl.get(message.requestId as string); if (pending) pending.turnId = accepted.turnId; socket.send(JSON.stringify({ type: "result", protocolVersion: "codex-assistant.v3", requestId: message.requestId, threadId: message.threadId, status: "started" })); }).catch((error: unknown) => { this.#pendingControl.delete(message.requestId as string); socket.send(JSON.stringify({ type: "result", protocolVersion: "codex-assistant.v3", requestId: message.requestId, threadId: message.threadId, status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : "SEND_FAILED" })); });
          return;
        }
        if (message.type === "detail" && typeof message.requestId === "string" && typeof message.threadId === "string") {
          void this.readDetail(message.threadId, typeof message.cursor === "string" ? message.cursor : undefined).then((detail) => socket.send(JSON.stringify({ type: "detail", protocolVersion: "codex-assistant.v3", requestId: message.requestId, threadId: message.threadId, turns: detail.turns, ...(detail.cursor ? { cursor: detail.cursor } : {}) }))).catch((error: unknown) => socket.send(JSON.stringify({ type: "result", protocolVersion: "codex-assistant.v3", requestId: message.requestId, threadId: message.threadId, status: "failed", error: error instanceof Error ? error.message.slice(0, 500) : "DETAIL_FAILED" })));
        }
        if (message.type === "interaction.submit" && typeof message.requestId === "string" && typeof message.threadId === "string") {
          this.submitInteraction(message.requestId, message.threadId, message.value);
        }
      } catch { /* invalid control frames are ignored */ }
    });
    socket.on("close", () => { if (this.#controlSocket === socket) { this.#controlSocket = undefined; this.#controlConnected = false; this.#pendingControl.clear(); } });
    socket.on("error", () => undefined);
  }

  #handleRequest(request: AppServerRequest): void {
    const pending = createInteraction(request);
    if (!pending) { this.#server.respondError(request.id, -32601, "Unsupported request without thread context"); return; }
    this.#interactions.set(pending.request.requestId, pending);
    this.#sendControl(pending.request);
  }

  #handleNotification(notification: AppServerNotification): void {
    const params = notification.params;
    const threadId = typeof params.threadId === "string" ? params.threadId : undefined;
    if (notification.method === "serverRequest/resolved") { this.#expireInteractions(threadId, params.requestId); return; }
    const terminal = notification.method === "turn/completed";
    if (!threadId) return;
    const turn = asRecord(params.turn);
    if (terminal) this.#expireInteractions(threadId);
    const delta = typeof params.delta === "string" ? params.delta : undefined;
    for (const [requestId, pending] of this.#pendingControl) {
      if (pending.threadId !== threadId || !pending.turnId || (turn.id && pending.turnId !== turn.id)) continue;
      const status = terminal ? (turn.status === "completed" && !turn.error ? "completed" : "failed") : delta ? "streaming" : "started";
      this.#sendControl({ type: "result", protocolVersion: "codex-assistant.v3", requestId, threadId, status, ...(delta ? { text: delta.slice(0, 20_000) } : {}) });
      if (terminal) this.#pendingControl.delete(requestId);
    }
  }

  async #poll(): Promise<void> {
    if (this.#polling || this.#stopping) return;
    this.#connectControl();
    this.#polling = true;
    let finish!: () => void;
    this.#pollFinished = new Promise<void>(resolve => { finish = resolve; });
    this.#onStatus("syncing");
    const trace = newTraceContext();
    const startedAt = performance.now();
    this.#server.setTraceContext(trace);
    try {
      await this.#server.start();
      const threads = await this.#server.listThreads();
      const seen = new Set(threads.map((thread) => thread.id));
      this.#lifecycle.retain(seen);
      for (const id of this.#threadCache.keys()) if (!seen.has(id)) { this.#threadCache.delete(id); this.#inProgressItems.delete(id); }
      for (const id of Object.keys(this.#outbox.fingerprints)) if (!seen.has(id) && !this.#outbox.events.some((event) => event.task.id === id)) delete this.#outbox.fingerprints[id];
      while (Object.keys(this.#outbox.fingerprints).length > MAX_FINGERPRINTS) delete this.#outbox.fingerprints[Object.keys(this.#outbox.fingerprints)[0]];
      let tasks = await mapLimit(threads, RPC_CONCURRENCY, async (thread) => {
        try { return await this.#normalizeCached(thread); }
      catch { return this.#staleTask(thread); }
      });
      tasks = tasks.map(task => this.interactions.some(r => r.threadId === task.id) ? { ...task, status: "needs_action" } : task);
      this.#onTasks(tasks);
      for (const task of tasks) await this.#enqueue(task);
      await this.#flush(trace);
      await this.#flushTraceBuffer();
      this.#recordSpan(this.#span(trace, "desktop.poll", startedAt, { threads: String(threads.length), tasks: String(tasks.length), outbox: String(this.#outbox.events.length) }));
      this.#onStatus("connected");
    } catch (error) {
      this.#recordSpan(this.#span(trace, "desktop.poll.error", startedAt, { error: error instanceof Error ? error.message.slice(0, 120) : "unknown" }));
      this.#onStatus("offline");
    } finally {
      this.#server.setTraceContext(undefined);
      this.#polling = false;
      finish();
      this.#pollFinished = undefined;
    }
  }

  #span(parent: TraceContext, name: string, startedAt: number, attributes: Record<string, string>): TraceSpan {
    const context = childTrace(parent);
    return { ...context, name, startedAt: new Date(Date.now() - Math.max(0, performance.now() - startedAt)).toISOString(), endedAt: new Date().toISOString(), attributes };
  }

  async #normalizeCached(thread: AppServerThread): Promise<TaskSnapshot> {
    const lifecycle = await this.#lifecycle.read(thread.id, thread.path);
    const stamp = JSON.stringify([thread.updatedAt, thread.status, thread.name, thread.preview, this.#server.planRevision(thread.id), this.#server.latestTurn(thread.id)]);
    const cached = this.#threadCache.get(thread.id);
    if (cached?.stamp === stamp) {
      cached.lifecycle = lifecycle;
      return applyLifecycle(cached.task, lifecycle, Date.now(), this.#inProgressItems.get(thread.id) === true);
    }
    const task = await this.#normalize(thread, lifecycle);
    const entry: CachedTask = { stamp, task, lifecycle };
    this.#threadCache.set(thread.id, entry);
    return applyLifecycle(task, lifecycle, Date.now(), this.#inProgressItems.get(thread.id) === true);
  }

  #staleTask(thread: AppServerThread): TaskSnapshot {
    const updatedAt = this.#timestamp(thread.updatedAt);
    const runtimeStatus = normalizeRuntimeStatus(thread.status);
    const activeFlags = normalizeActiveFlags(thread.status);
    const entry = this.#threadCache.get(thread.id);
    // 文件暂不可读时仍重新检查旧证据的有效期，不能借错误路径永久冻结 active。
    const cached = entry ? applyLifecycle(entry.task, entry.lifecycle, Date.now(), this.#inProgressItems.get(thread.id) === true) : undefined;
    // 读取失败不意味着任务发生了变化：缓存的来源时间必须与缓存内容一起保留。
    if (cached) return { ...cached, freshness: "stale", error: cached.error?.code === "ACTIVE_EVIDENCE_EXPIRED" ? cached.error : { code: "DETAIL_UNAVAILABLE", message: "线程详情暂时不可用，显示最近一次状态" } };
    return { id: thread.id, title: sanitizeText(thread.name || thread.preview || thread.id), ...(projectName(thread.cwd) ? { projectName: projectName(thread.cwd) } : {}), status: deriveTaskStatus(undefined, runtimeStatus, activeFlags, undefined), runtimeStatus, activeFlags, freshness: "unavailable", source: "thread", plan: [], updatedAt, changedAt: updatedAt, error: { code: "DETAIL_UNAVAILABLE", message: "线程详情暂时不可用" } };
  }

  async #normalize(thread: AppServerThread, lifecycle?: Lifecycle): Promise<TaskSnapshot> {
    const [read, goal, turns, items] = await Promise.all([this.#server.readThread(thread.id), this.#server.getGoal(thread.id), this.#server.listTurns(thread.id), this.#server.listItems(thread.id)]);
    const loaded = asRecord(read).thread;
    const currentThread = loaded && typeof loaded === "object" ? { ...(loaded as AppServerThread), ...thread } : thread;
    const goalData = goal && typeof goal === "object" ? goal as Record<string, unknown> : undefined;
    const turnRows = asRecord(turns).data ?? turns;
    const latestTurn = normalizeTurn(this.#server.latestTurn(thread.id)) ?? (Array.isArray(turnRows) ? normalizeTurn(turnRows[0]) : undefined);
    const runtimeStatus = normalizeRuntimeStatus(currentThread.status);
    const activeFlags = normalizeActiveFlags(currentThread.status);
    const goalStatus = typeof goalData?.status === "string" ? normalizeStatus(goalData.status) : undefined;
    const title = sanitizeText(goalData?.objective || currentThread.name || currentThread.preview || currentThread.id);
    const plan = this.#plan(turns, items, this.#server.planFor(thread.id));
    const currentStep = plan.find((step) => step.status === "in_progress") ?? plan.find((step) => step.status === "pending");
    const itemList = this.#items(items);
    this.#inProgressItems.set(currentThread.id, this.#hasInProgressItem(items, lifecycle));
    const latestAction = itemList.find((item) => item.status === "inProgress")?.type ?? itemList[0]?.type;
    const updatedAt = this.#timestamp(currentThread.updatedAt);
    const status = deriveTaskStatus(goalStatus, runtimeStatus, activeFlags, latestTurn);
    const error = latestTurn?.error;
    return { id: currentThread.id, title, ...(projectName(currentThread.cwd) ? { projectName: projectName(currentThread.cwd) } : {}), status, runtimeStatus, activeFlags, freshness: "fresh", source: goalStatus ? "goal" : "thread", ...(goalStatus ? { goal: { objective: sanitizeText(goalData?.objective), status: goalStatus, timeUsedSeconds: Number.isFinite(goalData?.timeUsedSeconds) ? Math.max(0, Math.trunc(Number(goalData?.timeUsedSeconds))) : 0, tokensUsed: Number.isFinite(goalData?.tokensUsed) ? Math.max(0, Math.trunc(Number(goalData?.tokensUsed))) : 0, ...(Number.isFinite(goalData?.tokenBudget) ? { tokenBudget: Math.max(0, Math.trunc(Number(goalData?.tokenBudget))) } : {}) } } : {}), ...(latestTurn ? { latestTurn } : {}), ...(error ? { error } : {}), plan, ...(currentStep ? { currentStepId: currentStep.id } : {}), ...(latestAction && normalizeAction(latestAction) ? { action: normalizeAction(latestAction) } : {}), updatedAt, changedAt: updatedAt };
  }

  #timestamp(value: unknown): string {
    if (typeof value === "number" && Number.isFinite(value)) return new Date(value > 10_000_000_000 ? value : value * 1000).toISOString();
    if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
    return new Date().toISOString();
  }

  #plan(turnsValue: unknown, itemsValue: unknown, notifiedPlan?: AppServerPlanStep[]): PlanStep[] {
    if (notifiedPlan?.length) return this.#planRows(notifiedPlan);
    const turnRows = asRecord(turnsValue).data ?? turnsValue;
    const externalItems = this.#items(itemsValue);
    const turnItems = Array.isArray(turnRows) ? turnRows.flatMap((turn) => { const items = asRecord(turn).items; return Array.isArray(items) ? items.map((item) => asRecord(item)) : []; }) : [];
    const planItems = [...turnItems, ...externalItems].filter((item) => item.type === "plan");
    const latest = planItems[0];
    if (latest && typeof latest.text === "string") {
      try { const parsed = JSON.parse(latest.text) as unknown; if (Array.isArray(parsed)) return this.#planRows(parsed); } catch { /* 明文计划继续按行解析 */ }
      const lines = latest.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const parsed = lines.map((line, index) => ({ id: `step-${index + 1}`, title: line.replace(/^[-*]\s*(?:\[[ xX]\]\s*)?/, ""), status: /\[[xX]\]|complete|done/i.test(line) ? "completed" : "pending" }));
      if (parsed.length) return this.#planRows(parsed);
    }
    return [];
  }

  #planRows(value: unknown[]): PlanStep[] {
    return value.slice(0, 100).map((row, index) => { const item = asRecord(row); const rawStatus = String(item.status ?? "pending"); const status: PlanStep["status"] = /complete|done/i.test(rawStatus) ? "completed" : /progress|running|active/i.test(rawStatus) ? "in_progress" : /fail|error/i.test(rawStatus) ? "failed" : "pending"; return { id: sanitizeText(item.id ?? `step-${index + 1}`, 200), title: sanitizeText(item.title ?? item.name ?? item.step ?? `Step ${index + 1}`), status }; });
  }

  #items(value: unknown): AppServerItem[] {
    const rows = asRecord(value).data ?? value;
    return Array.isArray(rows) ? rows.map((row) => { const record = asRecord(row); return (record.item && typeof record.item === "object" ? record.item : record) as AppServerItem; }).slice(0, 100) : [];
  }

  #hasInProgressItem(value: unknown, lifecycle?: Lifecycle): boolean {
    if (!lifecycle || lifecycle.turn.status !== "inProgress") return false;
    const rows = asRecord(value).data ?? value;
    if (!Array.isArray(rows)) return false;
    return rows.some((row) => {
      const entry = asRecord(row);
      if (typeof entry.turnId === "string" && entry.turnId !== lifecycle.turnId) return false;
      const item = asRecord(entry.item ?? entry);
      return item.status === "inProgress";
    });
  }

  async #enqueue(task: TaskSnapshot): Promise<void> {
    const nextFingerprint = fingerprint(task);
    if (this.#outbox.fingerprints[task.id] === nextFingerprint) return;
    if (this.#outbox.events.length >= MAX_OUTBOX_EVENTS) throw new Error("OUTBOX_LIMIT");
    const trace = newTraceContext();
    this.#outbox.fingerprints[task.id] = nextFingerprint;
    this.#outbox.events.push({ protocolVersion: "codex-assistant.v3", deviceId: this.#deviceId, localSequence: this.#outbox.nextSequence++, occurredAt: new Date().toISOString(), trace, task, fingerprint: nextFingerprint });
    await this.#persist();
  }

  async #flush(parent: TraceContext): Promise<void> {
    if (Date.now() < this.#nextFlushAt) return;
    while (this.#outbox.events.length) {
      const event = this.#outbox.events[0];
      const { fingerprint: _fingerprint, ...wireEvent } = event;
      const startedAt = performance.now();
      try {
        const response = await fetch(`${this.#apiUrl}/codex-assistant/api/v3/events`, { method: "POST", headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json", traceparent: traceparent(event.trace) }, body: JSON.stringify(wireEvent), signal: AbortSignal.timeout(10_000) });
        if (!response.ok) { this.#scheduleRetry(); return; }
        this.#outbox.events.shift();
        this.#flushAttempt = 0;
        this.#nextFlushAt = 0;
        await this.#persist();
        this.#recordSpan(this.#span(parent, "desktop.upload", startedAt, { status: String(response.status), latencyMs: String(Math.trunc(performance.now() - startedAt)) }));
      } catch (error) {
        this.#recordSpan(this.#span(parent, "desktop.upload.error", startedAt, { error: error instanceof Error ? error.message.slice(0, 100) : "unknown" }));
        this.#scheduleRetry();
        return;
      }
    }
  }

  #scheduleRetry(): void {
    this.#flushAttempt = Math.min(this.#flushAttempt + 1, 6);
    this.#nextFlushAt = Date.now() + Math.min(60_000, 1_000 * 2 ** (this.#flushAttempt - 1));
  }

  async #persist(): Promise<void> {
    const temporary = `${this.#statePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#outbox)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, this.#statePath);
    await rm(temporary, { force: true });
  }

  #recordSpan(span: TraceSpan): void {
    this.#traceLogger.record(span);
    this.#traceBuffer.push(span);
    if (this.#traceBuffer.length > 100) this.#traceBuffer.splice(0, this.#traceBuffer.length - 100);
  }

  async #flushTraceBuffer(): Promise<void> {
    if (!this.#traceBuffer.length) return;
    const spans = this.#traceBuffer.slice(0, 100);
    try {
      const response = await fetch(`${this.#apiUrl}/codex-assistant/api/v3/traces/spans`, {
        method: "POST",
        headers: { authorization: `Bearer ${this.#token}`, "content-type": "application/json" },
        body: JSON.stringify({ protocolVersion: "codex-assistant.v3", spans }),
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) this.#traceBuffer.splice(0, spans.length);
    } catch {
      // 本地 JSONL 是 trace 的可靠副本，上传失败不能阻塞任务同步。
    }
  }
}

function parseStrictEvent(value: unknown): IngestEvent | undefined {
  // TypeBox schema 校验放在恢复路径，损坏 outbox 直接停机而不是静默丢事件。
  return parseStrict(IngestEventSchema, value) as IngestEvent | undefined;
}

export function deviceIdFromInstall(seed: string): string { return createHash("sha256").update(seed).digest("hex").slice(0, 32); }

/** 保留独立 RPC 的官方运行态；本机生命周期只修正最近回合，不能伪造 active flags。 */
export function applyLifecycle(task: TaskSnapshot, lifecycle?: Lifecycle, now = Date.now(), hasInProgressItem = false): TaskSnapshot {
  if (task.runtimeStatus !== "notLoaded") return task;
  if (!lifecycle) {
    if (task.status !== "running") return task;
    return { ...task, status: "needs_action", freshness: "unavailable", error: { code: "ACTIVE_EVIDENCE_UNAVAILABLE", message: "无有效运行证据，状态待确认" } };
  }
  const { error: _error, ...base } = task;
  const latestTurn = lifecycle.turn;
  const evidenceTime = Date.parse(lifecycle.evidenceAt);
  const updatedAt = Date.parse(task.updatedAt) > Date.parse(lifecycle.updatedAt) ? task.updatedAt : lifecycle.updatedAt;
  // 对话或元数据继续更新不应改变“进入当前回合状态”的时间。Goal 优先时保留 Goal 的时间。
  const changedAt = task.goal ? task.changedAt : lifecycle.updatedAt;
  // 文件写入时间只是一种有界活动证据，不是进程存活证明。容许文件时钟的亚秒精度差，
  // 超过一秒的未来时间视为异常，不能无限续期。
  // 明确的完成/中止事件不需要续期；Goal 的暂停、阻塞、完成等仍保留原有优先级。
  const evidenceAge = now - evidenceTime;
  if (latestTurn.status === "inProgress" && hasInProgressItem && Number.isFinite(evidenceTime) && evidenceTime <= now + 1_000 && evidenceAge < IN_PROGRESS_ITEM_MAX_AGE_MS) {
    const status = deriveTaskStatus(task.goal?.status, task.runtimeStatus, task.activeFlags, latestTurn);
    return { ...base, latestTurn, status, updatedAt, changedAt, freshness: evidenceAge < ACTIVE_EVIDENCE_MAX_AGE_MS ? "fresh" : "stale" };
  }
  if (latestTurn.status === "inProgress" && (!Number.isFinite(evidenceTime) || evidenceTime > now + 1_000 || now - evidenceTime >= ACTIVE_EVIDENCE_MAX_AGE_MS)) {
    const status = "needs_action";
    return { ...base, latestTurn, status, updatedAt, changedAt, freshness: "stale",
      error: { code: "ACTIVE_EVIDENCE_EXPIRED", message: "近期无有效运行证据，运行状态待确认；未判定为完成或失败" } };
  }
  return { ...base, latestTurn, status: deriveTaskStatus(task.goal?.status, task.runtimeStatus, task.activeFlags, latestTurn),
    ...(latestTurn.error ? { error: latestTurn.error } : {}), updatedAt, changedAt };
}
