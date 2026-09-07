import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { createInterface, type Interface } from "node:readline";
import { join } from "node:path";
import type { TraceContext, TraceSpan } from "@codex-assistant/protocol";

type RpcResponse = { id?: number; result?: unknown; error?: { message?: string } };
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export type AppServerThread = {
  id: string; name?: string; preview?: string; cwd?: string; status?: string | { type?: string; activeFlags?: string[] }; updatedAt?: string | number;
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
  #lines?: Interface;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #plans = new Map<string, { revision: number; steps: AppServerPlanStep[] }>();
  #activeTrace?: TraceContext;
  #onSpan?: (span: TraceSpan) => void;
  #onLog?: (message: string) => void;
  #lastStartFailureAt = 0;

  constructor(options: { onSpan?: (span: TraceSpan) => void; onLog?: (message: string) => void } = {}) {
    this.#onSpan = options.onSpan;
    this.#onLog = options.onLog;
  }

  setTraceContext(context: TraceContext | undefined): void { this.#activeTrace = context; }

  async start(): Promise<void> {
    if (this.#child) return;
    if (Date.now() - this.#lastStartFailureAt < 1_000) throw new Error("APP_SERVER_RESTART_BACKOFF");
    const command = resolveCodexCommand();
    try {
      this.#child = spawn(command, ["app-server", "--listen", "stdio://"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      this.#lines = createInterface({ input: this.#child.stdout, crlfDelay: Infinity });
      this.#lines.on("line", (line) => this.#handleLine(line));
      this.#child.stderr.setEncoding("utf8");
      this.#child.stderr.on("data", (chunk) => this.#onLog?.(`app-server stderr: ${String(chunk).trim().slice(0, 1000)}`));
      this.#child.once("error", (error) => {
        this.#onLog?.(`app-server error: ${error.message}`);
        for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("APP_SERVER_SPAWN_FAILED")); }
        this.#pending.clear();
      });
      this.#child.once("exit", (code, signal) => {
        this.#onLog?.(`app-server exited code=${code ?? "null"} signal=${signal ?? "null"}`);
        this.#lastStartFailureAt = Date.now();
        this.#child = undefined;
        this.#lines?.close();
        for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("APP_SERVER_EXITED")); }
        this.#pending.clear();
      });
      await this.request("initialize", { clientInfo: { name: "codex-assistant", version: "2.0.0" } }, INITIALIZE_TIMEOUT_MS);
      this.notify("initialized", {});
    } catch (error) {
      this.#lastStartFailureAt = Date.now();
      await this.stop();
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.#lines?.close();
    this.#child?.kill();
    this.#child = undefined;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(new Error("APP_SERVER_STOPPED")); }
    this.#pending.clear();
  }

  notify(method: string, params: unknown): void {
    if (!this.#child?.stdin.writable) throw new Error("APP_SERVER_NOT_RUNNING");
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
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
    return [...new Map(threads.map((thread) => [thread.id, thread])).values()];
  }

  async readThread(idValue: string): Promise<unknown> { return this.request("thread/read", { threadId: idValue }); }
  async listTurns(idValue: string): Promise<unknown> { return this.request("thread/turns/list", { threadId: idValue, limit: 20, itemsView: "summary", sortDirection: "desc" }); }
  async listItems(idValue: string): Promise<unknown> { return this.request("thread/items/list", { threadId: idValue, limit: 100, sortDirection: "desc" }); }
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
