import { open, type FileHandle } from "node:fs/promises";
import type { LatestTurn } from "@codex-assistant/protocol";

export type Lifecycle = { turnId: string; turn: LatestTurn; updatedAt: string };
type Cursor = {
  path: string; identity: string; offset: number; mtime: number; pending: Buffer;
  latest?: Lifecycle; search?: { end: number; position: number; suffix: Buffer };
};
const CHUNK = 64 * 1024;
const READ_BUDGET = 2 * 1024 * 1024;
const MAX_RECORD = 1024 * 1024;

/** 仅选择生命周期元数据。正文、命令、路径、输出及错误原文永不进入返回值。 */
export function lifecycleEvent(line: string): Lifecycle | undefined {
  if (!line.includes('"event_msg"') || !/"(?:task_started|task_complete|turn_aborted)"/.test(line)) return undefined;
  const row = JSON.parse(line) as { type?: string; timestamp?: string; payload?: Record<string, unknown> };
  const p = row.payload;
  if (row.type !== "event_msg" || !p || typeof p.turn_id !== "string" || typeof row.timestamp !== "string" || !Number.isFinite(Date.parse(row.timestamp))) return undefined;
  if (p.type !== "task_started" && p.type !== "task_complete" && p.type !== "turn_aborted") return undefined;
  const updatedAt = new Date(row.timestamp).toISOString();
  const status = p.type === "task_started" ? "inProgress" : p.type === "turn_aborted" ? "interrupted" : p.error ? "failed" : "completed";
  const turn: LatestTurn = {
    status,
    ...(p.type === "task_started" ? { startedAt: updatedAt } : { completedAt: updatedAt }),
    ...(status === "failed" ? { error: { code: "TURN_FAILED", message: "回合执行失败" } } : {}),
  };
  return { turnId: p.turn_id, turn, updatedAt };
}

function reduce(previous: Lifecycle | undefined, next: Lifecycle): Lifecycle {
  if (previous && next.updatedAt < previous.updatedAt) return previous;
  // 较早回合的迟到终止事件不能结束当前回合。
  if (previous?.turn.status === "inProgress" && next.turn.status !== "inProgress" && previous.turnId !== next.turnId) return previous;
  return next;
}

/**
 * 独立 app-server 无法观察另一个进程的运行态。使用 thread/list 返回的 rollout 路径，
 * 只读提取开始/完成/中止事件。冷启动从文件尾向前找，之后只读取新增字节。
 * 每线程每轮最多读取 2 MiB；解析尚未追上文件时返回不可用，绝不把旧事件当实时状态。
 * 不扫描会话目录，不修改 Codex 数据，不把文件路径或原始记录写入 outbox/trace。
 */
export class LifecycleReader {
  #cursors = new Map<string, Cursor>();

  retain(ids: Set<string>): void {
    for (const id of this.#cursors.keys()) if (!ids.has(id)) this.#cursors.delete(id);
  }

  async read(id: string, path?: string | null): Promise<Lifecycle | undefined> {
    if (!path) { this.#cursors.delete(id); return undefined; }
    const file = await open(path, "r");
    try {
      const stat = await file.stat();
      const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
      let cursor = this.#cursors.get(id);
      if (!cursor || cursor.path !== path || cursor.identity !== identity || stat.size < cursor.offset || (stat.size === cursor.offset && stat.mtimeMs !== cursor.mtime)) {
        cursor = { path, identity, offset: stat.size, mtime: stat.mtimeMs, pending: Buffer.alloc(0), search: { end: stat.size, position: stat.size, suffix: Buffer.alloc(0) } };
        this.#cursors.set(id, cursor);
      }
      let budget = READ_BUDGET;
      while (cursor.search && budget > 0) {
        const search = cursor.search;
        const length = Math.min(CHUNK, search.position);
        const position = search.position - length;
        const chunk = await this.#read(file, position, length);
        budget -= length;
        let data = Buffer.concat([chunk, search.suffix]);
        if (search.position === search.end) {
          const lastNewline = data.lastIndexOf(10);
          cursor.pending = Buffer.from(data.subarray(lastNewline + 1));
          data = data.subarray(0, lastNewline + 1);
        }
        let end = data.length;
        while (end > 0) {
          const previousNewline = end <= 1 ? -1 : data.lastIndexOf(10, end - 2);
          if (previousNewline < 0 && position > 0) break;
          const event = lifecycleEvent(data.subarray(previousNewline + 1, end).toString("utf8"));
          if (event) { cursor.latest = event; cursor.search = undefined; break; }
          end = previousNewline + 1;
        }
        if (cursor.search) {
          search.position = position;
          search.suffix = Buffer.from(data.subarray(0, end));
          if (search.suffix.length > MAX_RECORD || cursor.pending.length > MAX_RECORD) throw new Error("LIFECYCLE_RECORD_LIMIT");
          if (position === 0) cursor.search = undefined;
        }
      }
      if (cursor.search) throw new Error("LIFECYCLE_CATCHING_UP");
      while (cursor.offset < stat.size && budget > 0) {
        const length = Math.min(CHUNK, stat.size - cursor.offset, budget);
        const chunk = await this.#read(file, cursor.offset, length);
        const data = Buffer.concat([cursor.pending, chunk]);
        let begin = 0;
        for (let end = data.indexOf(10); end >= 0; end = data.indexOf(10, begin)) {
          const event = lifecycleEvent(data.subarray(begin, end).toString("utf8"));
          if (event) cursor.latest = reduce(cursor.latest, event);
          begin = end + 1;
        }
        cursor.pending = Buffer.from(data.subarray(begin));
        cursor.offset += length;
        budget -= length;
        if (cursor.pending.length > MAX_RECORD) throw new Error("LIFECYCLE_RECORD_LIMIT");
      }
      cursor.mtime = stat.mtimeMs;
      if (cursor.offset < stat.size) throw new Error("LIFECYCLE_CATCHING_UP");
      return cursor.latest;
    } finally { await file.close(); }
  }

  async #read(file: FileHandle, position: number, length: number): Promise<Buffer> {
    const data = Buffer.allocUnsafe(length);
    const { bytesRead } = await file.read(data, 0, length, position);
    if (bytesRead !== length) throw new Error("LIFECYCLE_FILE_CHANGED");
    return data;
  }
}
