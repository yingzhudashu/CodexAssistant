import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { join } from "node:path";
import type { TraceContext, TraceSpan } from "@codex-assistant/protocol";

type RpcResponse = { id?: number | string; result?: unknown; error?: { message?: string } };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };
export type AppServerNotification = { method: string; params: Record<string, unknown> };
export type AppServerRequest = { id: number | string; method: string; params: Record<string, unknown> };

export type AppServerThread = {
  id: string; path?: string | null; name?: string; preview?: string; cwd?: string; status?: string | { type?: string; activeFlags?: string[] }; updatedAt?: string | number;
};
export type AppServerGoal = { objective?: string; status?: string; timeUsedSeconds?: number; tokensUsed?: number; tokenBudget?: number };
export type AppServerItem = { type?: string; status?: string; text?: string; name?: string; content?: unknown };
export type AppServerPlanStep = { step?: string; status?: string };
export type AppServerTurn = { status?: string; startedAt?: string | number; completedAt?: string | number; durationMs?: number; error?: { code?: string; message?: string } | null };

const RPC_TIMEOUT_MS = 15_000;
const INITIALIZE_TIMEOUT_MS = 90_000;
const MAX_JSON_LINE = 2 * 1024 * 1024;

function id(bytes: number): string { return randomBytes(bytes).toString("hex"); }
function spanContext(parent?: TraceContext): TraceContext {
  return parent ? { traceId: parent.traceId, spanId: id(8), parentSpanId: parent.spanId } : { traceId: id(16), spanId: id(8) };
}

/**
 * Electron 从资源管理器启动时不会保证继承当前 PowerShell 的 PATH。
 * Codex Desktop 的 Windows CLI 位于版本目录下，因此先解析已安装的
 * 官方 codex.exe，避免把“找不到命令”误报成通用的 APP_SERVER_STOPPED。
 */
function resolveCodexCommand(): string {
  const configured = process.env.CODEX_BIN?.trim();
  if (configured) return configured;
  if (process.platform === "win32") {
    const root = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "OpenAI", "Codex", "bin") : "";
    if (root && existsSync(root)) {
      const candidates = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, entry.name, "codex.exe"))
        .filter((candidate) => existsSync(candidate))
        .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs);
      if (candidates[0]) return candidates[0];
    }
  }
  return "codex";
}

/** 官方 app-server 的最小 JSON-RPC 客户端。所有请求都有超时，避免一个悬挂 RPC 卡死整个轮询。 */
export class CodexAppServer {
  #child?: ChildProcessWithoutNullStreams;
  #ready = false;
  #starting?: Promise<void>;
  #lines?: Interface;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #plans = new Map<string, { revision: number; steps: AppServerPlanStep[] }>();
  #threadStatuses = new Map<string, AppServerThread["status"]>();
  #latestTurns = new Map<string, unknown>();
  #activeTrace?: TraceContext;
  #onSpan?: (span: TraceSpan) => void;
  #onLog?: (message: string) => void;
  #lastStartFailureAt = 0;
  #onNotification?: (notification: AppServerNotification) => void;
  #onRequest?: (request: AppServerRequest) => void;
  #onExit?: () => void;

  constructor(options: { onSpan?: (span: TraceSpan) => void; onLog?: (message: string) => void; onNotification?: (notification: AppServerNotification) => void; onRequest?: (request: AppServerRequest) => void; onExit?: () => void } = {}) {
    this.#onSpan = options.onSpan;
    this.#onLog = options.onLog;
    this.#onNotification = options.onNotification;
    this.#onRequest = options.onRequest;
    this.#onExit = options.onExit;
  }

  setTraceContext(context: TraceContext | undefined): void { this.#activeTrace = context; }

  get ready(): boolean { return this.#ready; }

  async start(): Promise<void> {
    if (this.#starting) return this.#starting;
    if (this.#ready && this.#child) return;
    const starting = this.#initialize();
    this.#starting = starting;
    try { await starting; } finally { if (this.#starting === starting) this.#starting = undefined; }
  }

  async #initialize(): Promise<void> {
    if (Date.now() - this.#lastStartFailureAt < 1_000) throw new Error("APP_SERVER_RESTART_BACKOFF");
    this.#plans.clear();
    this.#threadStatuses.clear();
    this.#latestTurns.clear();
    const command = resolveCodexCommand();
    try {
      this.#child = spawn(command, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      this.#lines = createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
      this.#lines.on("line", (line) => this.#handleLine(line));
      this.#child.stderr.setEncoding("utf8");
      this.#child.stderr.on("data", (chunk) => this.#onLog?.(`app-server stderr: ${String(chunk).trim().slice(0, 1000)}`));
      this.#child.once("error", (error) => {
        this.#ready = false;
        this.#onLog?.(`app-server error: ${error.message}`);
        for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("APP_SERVER_SPAWN_FAILED")); }
        this.#pending.clear();
      });
      this.#child.once("exit", (code, signal) => {
        this.#ready = false;
        this.#onExit?.();
        this.#onLog?.(`app-server exited code=${code ?? "null"} signal=${signal ?? "null"}`);
        this.#lastStartFailureAt = Date.now();
        this.#child = undefined;
        this.#lines?.close();
        for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("APP_SERVER_EXITED")); }
        this.#pending.clear();
      });
      await this.request("initialize", { clientInfo: { name: "codex-assistant", version: "2.0.12" }, capabilities: { experimentalApi: true } }, INITIALIZE_TIMEOUT_MS);
      this.notify("initialized", {});
      this.#ready = true;
    } catch (error) {
      this.#lastStartFailureAt = Date.now();
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#ready = false;
    this.#lines?.close();
    const child = this.#child;
    if (child && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        child.kill();
      });
    }
    if (this.#child === child) this.#child = undefined;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("APP_SERVER_STOPPED")); }
    this.#pending.clear();
  }

  notify(method: string, params: unknown): void {
    if (!this.#child?.stdin.writable) throw new Error("APP_SERVER_NOT_RUNNING");
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  respond(idValue: number | string, result: unknown): void {
    if (!this.#child?.stdin.writable) throw new Error("APP_SERVER_NOT_RUNNING");
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: idValue, result })}\n`);
  }

  respondError(idValue: number | string, code: number, message: string): void {
    if (!this.#child?.stdin.writable) throw new Error("APP_SERVER_NOT_RUNNING");
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: idValue, error: { code, message } })}\n`);
  }

  async request(method: string, params: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
    if (!this.#child?.stdin.writable) throw new Error("APP_SERVER_NOT_RUNNING");
    const idValue = this.#nextId++;
    const context = spanContext(this.#activeTrace);
    const startedAt = new Date().toISOString();
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(idValue);
        reject(new Error("APP_SERVER_RPC_TIMEOUT"));
      }, timeoutMs);
      this.#pending.set(idValue, { resolve, reject, timer });
    });
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: idValue, method, params })}\n`);
    return response.finally(() => this.#onSpan?.({ ...context, name: `app_server.${method.replace(/[^A-Za-z0-9_.-]/g, "_")}`, startedAt, endedAt: new Date().toISOString() }));
  }

  async listThreads(): Promise<AppServerThread[]> {
    const threads: AppServerThread[] = [];
    for (const archived of [false, true]) {
      let cursor: string | null = null;
      do {
        const result = await this.request("thread/list", { limit: 100, archived, sortKey: "updated_at", sortDirection: "desc", useStateDbOnly: true, cursor });
        const page = result as { data?: unknown[]; nextCursor?: string | null };
        const rows = page.data ?? [];
        threads.push(...rows.filter((row): row is AppServerThread => Boolean(row && typeof row === "object" && typeof (row as AppServerThread).id === "string")));
        cursor = page.nextCursor ?? null;
      } while (cursor);
    }
    const ids = new Set(threads.map(thread => thread.id));
    for (const cache of [this.#plans, this.#threadStatuses, this.#latestTurns]) {
      for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
    }
    return [...new Map(threads.map((thread) => [thread.id, { ...thread, ...(this.#threadStatuses.has(thread.id) ? { status: this.#threadStatuses.get(thread.id) } : {}) }])).values()];
  }

  async readThread(idValue: string): Promise<unknown> { return this.request("thread/read", { threadId: idValue }); }
  async listTurns(idValue: string, cursor?: string): Promise<unknown> { return this.request("thread/turns/list", { threadId: idValue, limit: 20, itemsView: "summary", sortDirection: "desc", cursor: cursor ?? null }); }
  async recoverActiveTurn(idValue: string): Promise<{ id?: string; status?: string } | undefined> {
    const value = await this.listTurns(idValue);
    const rows = (value as { data?: unknown[] })?.data;
    if (!Array.isArray(rows)) return undefined;
    const active = rows.find((row) => row && typeof row === "object" && (row as { status?: unknown }).status === "inProgress") as { id?: unknown; status?: unknown } | undefined;
    return typeof active?.id === "string" ? { id: active.id, status: "inProgress" } : undefined;
  }
  latestTurn(idValue: string): unknown | undefined { return this.#latestTurns.get(idValue); }
  ownsTurn(idValue: string, turnId: string): boolean {
    const turn = this.#latestTurns.get(idValue) as { id?: unknown } | undefined;
    return turn?.id === turnId;
  }
  async listItems(idValue: string, cursor?: string): Promise<unknown> { return this.request("thread/items/list", { threadId: idValue, limit: 100, sortDirection: "desc", cursor: cursor ?? null }); }
  async resumeThread(idValue: string): Promise<unknown> {
    const value = await this.request("thread/resume", { threadId: idValue }) as { thread?: { turns?: unknown[] } };
    const turn = value.thread?.turns?.at(-1);
    if (turn) this.#latestTurns.set(idValue, turn);
    return value;
  }
  async startTurn(idValue: string, text: string): Promise<unknown> {
    const value = await this.request("turn/start", { threadId: idValue, input: [{ type: "text", text }] }) as { turn?: unknown };
    if (value.turn) this.#latestTurns.set(idValue, value.turn);
    return value;
  }
  async steerTurn(idValue: string, turnId: string, text: string): Promise<unknown> {
    return this.request("turn/steer", { threadId: idValue, expectedTurnId: turnId, input: [{ type: "text", text }] });
  }
  planFor(threadId: string): AppServerPlanStep[] | undefined { return this.#plans.get(threadId)?.steps; }
  planRevision(threadId: string): number { return this.#plans.get(threadId)?.revision ?? 0; }
  async getGoal(idValue: string): Promise<AppServerGoal | undefined> {
    try {
      const result = await this.request("thread/goal/get", { threadId: idValue }) as { goal?: AppServerGoal | null };
      return result.goal ?? undefined;
    } catch {
      // 某些旧线程没有 Goal，按协议把它们视为无 Goal 线程，而不是中断整轮扫描。
      return undefined;
    }
  }

  #handleLine(line: string): void {
    if (line.length > MAX_JSON_LINE) { this.#onLog?.("app-server response exceeded 2 MiB"); return; }
    let message: RpcResponse & { method?: string; params?: unknown };
    try { message = JSON.parse(line) as RpcResponse & { method?: string; params?: unknown }; } catch { this.#onLog?.("app-server emitted invalid JSON"); return; }
    if (message.method && message.params && typeof message.params === "object") {
      if (message.id !== undefined) {
        this.#onRequest?.({ id: message.id, method: message.method, params: message.params as Record<string, unknown> });
        return; // Bidirectional JSON-RPC request IDs are independent namespaces.
      }
      else this.#onNotification?.({ method: message.method, params: message.params as Record<string, unknown> });
    }
    if (message.method === "thread/status/changed") {
      const params = message.params as { threadId?: unknown; status?: unknown };
      if (typeof params.threadId === "string" && params.status && typeof params.status === "object") this.#threadStatuses.set(params.threadId, params.status as AppServerThread["status"]);
      return;
    }
    if (message.method === "turn/started" || message.method === "turn/completed") {
      const params = message.params as { threadId?: unknown; turn?: unknown };
      if (typeof params.threadId === "string" && params.turn && typeof params.turn === "object") this.#latestTurns.set(params.threadId, params.turn);
      return;
    }
    if (message.method === "turn/plan/updated") {
      const params = message.params as { threadId?: unknown; plan?: unknown };
      if (typeof params.threadId === "string" && Array.isArray(params.plan)) {
        const previous = this.#plans.get(params.threadId)?.revision ?? 0;
        this.#plans.set(params.threadId, { revision: previous + 1, steps: params.plan.filter((step): step is AppServerPlanStep => Boolean(step && typeof step === "object")) });
      }
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message ?? "APP_SERVER_RPC_ERROR"));
    else pending.resolve(message.result);
  }
}
