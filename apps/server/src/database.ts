import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import type {
  IngestEvent,
  ServerEvent,
  TaskSnapshot,
  TraceContext,
  TraceSpan,
} from "@codex-assistant/protocol";

const SCHEMA_VERSION = 6;
const TABLES = ["devices", "task_events", "tasks", "trace_spans"];
const MAX_TRACE_SPANS = 100_000;

type EventRow = {
  sequence: number;
  device_id: string;
  local_sequence: number;
  occurred_at: string;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  snapshot: string;
};

type TaskRow = { snapshot: string };

export type InsertResult = {
  duplicate: boolean;
  event: ServerEvent;
  shouldNotify: boolean;
};

/** 单一本地SQLite文件拥有持久状态；schema不匹配直接拒绝启动。 */
export class TaskDatabase {
  readonly #database: DatabaseSync;
  #traceWritesSincePrune = 0;
  // SQL 文本来自本模块的固定语句，容量由源码决定，不接收用户输入作为缓存键。
  readonly #statements = new Map<string, StatementSync>();
  #statement(sql: string): StatementSync {
    let statement = this.#statements.get(sql);
    if (!statement) {
      statement = this.#database.prepare(sql);
      this.#statements.set(sql, statement);
    }
    return statement;
  }

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.#database = new DatabaseSync(path);
    this.#database.exec(
      "PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;",
    );
    try {
      this.#verifyOrInitialize();
      this.#pruneTraceSpans();
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  close(): void {
    this.#database.close();
  }

  #verifyOrInitialize(): void {
    const version = (
      this.#statement("PRAGMA user_version").get() as { user_version: number }
    ).user_version;
    const tables = (
      this.#statement(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      ).all() as Array<{ name: string }>
    ).map((row) => row.name);
    if (version === 0 && tables.length === 0) {
      this.#database.exec(`
        CREATE TABLE devices (
          device_id TEXT PRIMARY KEY,
          first_seen_at TEXT NOT NULL,
          last_seen_at TEXT NOT NULL
        );
        CREATE TABLE tasks (
          device_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          snapshot TEXT NOT NULL,
          changed_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          server_sequence INTEGER NOT NULL,
          PRIMARY KEY (device_id, task_id),
          FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE RESTRICT
        );
        CREATE TABLE task_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT,
          device_id TEXT NOT NULL,
          local_sequence INTEGER NOT NULL,
          task_id TEXT NOT NULL,
          occurred_at TEXT NOT NULL,
          trace_id TEXT NOT NULL,
          span_id TEXT NOT NULL,
          parent_span_id TEXT,
          snapshot TEXT NOT NULL,
          UNIQUE (device_id, local_sequence),
          FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE RESTRICT
        );
        CREATE TABLE trace_spans (
          span_id TEXT PRIMARY KEY,
          trace_id TEXT NOT NULL,
          parent_span_id TEXT,
          name TEXT NOT NULL,
          started_at TEXT NOT NULL,
          ended_at TEXT NOT NULL,
          attributes TEXT
        );
        CREATE INDEX task_events_sequence_idx ON task_events(sequence);
        CREATE INDEX tasks_updated_idx ON tasks(updated_at DESC);
        CREATE INDEX trace_spans_trace_idx ON trace_spans(trace_id, started_at);
        PRAGMA user_version = ${SCHEMA_VERSION};
      `);
      return;
    }
    if (version !== SCHEMA_VERSION || tables.join(",") !== TABLES.join(","))
      throw new Error("SCHEMA_MISMATCH");
  }

  insert(input: IngestEvent): InsertResult {
    const existing = this.#statement(
      "SELECT sequence, device_id, local_sequence, occurred_at, trace_id, span_id, parent_span_id, snapshot FROM task_events WHERE device_id = ? AND local_sequence = ?",
    ).get(input.deviceId, input.localSequence) as EventRow | undefined;
    if (existing)
      return {
        duplicate: true,
        event: this.#eventFromRow(existing),
        shouldNotify: false,
      };

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const now = new Date().toISOString();
      const snapshot = JSON.stringify(input.task);
      const previous = this.#statement(
        "SELECT snapshot FROM tasks WHERE device_id = ? AND task_id = ?",
      ).get(input.deviceId, input.task.id) as TaskRow | undefined;
      this.#statement(
        "INSERT INTO devices(device_id, first_seen_at, last_seen_at) VALUES (?, ?, ?) ON CONFLICT(device_id) DO UPDATE SET last_seen_at = excluded.last_seen_at",
      ).run(input.deviceId, now, now);
      const insert = this.#statement(
        "INSERT INTO task_events(device_id, local_sequence, task_id, occurred_at, trace_id, span_id, parent_span_id, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        input.deviceId,
        input.localSequence,
        input.task.id,
        input.occurredAt,
        input.trace.traceId,
        input.trace.spanId,
        input.trace.parentSpanId ?? null,
        snapshot,
      );
      const sequence = Number(insert.lastInsertRowid);
      this.#statement(
        `INSERT INTO tasks(device_id, task_id, snapshot, changed_at, updated_at, server_sequence)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(device_id, task_id) DO UPDATE SET
            snapshot = excluded.snapshot, changed_at = excluded.changed_at, updated_at = excluded.updated_at, server_sequence = excluded.server_sequence`,
      ).run(
        input.deviceId,
        input.task.id,
        snapshot,
        input.task.changedAt,
        input.task.updatedAt,
        sequence,
      );
      const event = {
        sequence,
        deviceId: input.deviceId,
        localSequence: input.localSequence,
        occurredAt: input.occurredAt,
        trace: input.trace,
        task: input.task,
      } satisfies ServerEvent;
      const previousTask = previous
        ? (JSON.parse(previous.snapshot) as TaskSnapshot)
        : undefined;
      this.#database.exec("COMMIT");
      return {
        duplicate: false,
        event,
        shouldNotify: Boolean(
          previousTask &&
          (previousTask.status !== input.task.status ||
            previousTask.currentStepId !== input.task.currentStepId),
        ),
      };
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  eventsAfter(sequence: number, limit = 500): ServerEvent[] {
    return (
      this.#statement(
        "SELECT sequence, device_id, local_sequence, occurred_at, trace_id, span_id, parent_span_id, snapshot FROM task_events WHERE sequence > ? ORDER BY sequence ASC LIMIT ?",
      ).all(
        sequence,
        Math.max(1, Math.min(5000, Math.trunc(limit))),
      ) as EventRow[]
    ).map((row) => this.#eventFromRow(row));
  }

  /** 将 span 作为幂等记录写入 SQLite，重复 span_id 不会造成新行。 */
  recordSpan(span: TraceSpan): void {
    this.#statement(
      `INSERT OR IGNORE INTO trace_spans(span_id, trace_id, parent_span_id, name, started_at, ended_at, attributes)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      span.spanId,
      span.traceId,
      span.parentSpanId ?? null,
      span.name,
      span.startedAt,
      span.endedAt,
      span.attributes ? JSON.stringify(span.attributes) : null,
    );
    if (++this.#traceWritesSincePrune >= 1000) {
      this.#pruneTraceSpans();
      this.#traceWritesSincePrune = 0;
    }
  }

  recordSpans(spans: TraceSpan[]): void {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const statement = this
        .#statement(`INSERT OR IGNORE INTO trace_spans(span_id, trace_id, parent_span_id, name, started_at, ended_at, attributes)
        VALUES (?, ?, ?, ?, ?, ?, ?)`);
      for (const span of spans)
        statement.run(
          span.spanId,
          span.traceId,
          span.parentSpanId ?? null,
          span.name,
          span.startedAt,
          span.endedAt,
          span.attributes ? JSON.stringify(span.attributes) : null,
        );
      this.#traceWritesSincePrune += spans.length;
      if (this.#traceWritesSincePrune >= 1000) {
        this.#pruneTraceSpans();
        this.#traceWritesSincePrune = 0;
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  /**
   * 每千次写入清理一次，按接收顺序保留十万条；峰值不超过十万零九百九十九条。
   * 使用 rowid 顺序扫描，避免每次写入按客户端时间全表排序，也不信任客户端未来时间。
   * 只清理诊断缓存，业务事件和任务快照不受影响。
   */
  #pruneTraceSpans(): void {
    this.#statement(
      `DELETE FROM trace_spans WHERE rowid <= (
      SELECT rowid FROM trace_spans ORDER BY rowid DESC LIMIT 1 OFFSET ?
    )`,
    ).run(MAX_TRACE_SPANS);
  }

  traceSpans(traceId: string, limit = 1000): TraceSpan[] {
    const rows = this.#statement(
      `SELECT trace_id, span_id, parent_span_id, name, started_at, ended_at, attributes
      FROM trace_spans WHERE trace_id = ? ORDER BY started_at ASC LIMIT ?`,
    ).all(traceId, Math.max(1, Math.min(1000, Math.trunc(limit)))) as Array<{
      trace_id: string;
      span_id: string;
      parent_span_id: string | null;
      name: string;
      started_at: string;
      ended_at: string;
      attributes: string | null;
    }>;
    return rows.map((row) => ({
      traceId: row.trace_id,
      spanId: row.span_id,
      ...(row.parent_span_id ? { parentSpanId: row.parent_span_id } : {}),
      name: row.name,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      ...(row.attributes
        ? { attributes: JSON.parse(row.attributes) as Record<string, string> }
        : {}),
    }));
  }

  metrics(): {
    eventCount: number;
    taskCount: number;
    traceSpanCount: number;
    cursor: number;
  } {
    const row = this.#statement(
      `SELECT
      (SELECT COUNT(*) FROM task_events) AS event_count,
      (SELECT COUNT(*) FROM tasks) AS task_count,
      (SELECT COUNT(*) FROM trace_spans) AS trace_span_count,
      (SELECT COALESCE(MAX(sequence), 0) FROM task_events) AS cursor`,
    ).get() as {
      event_count: number;
      task_count: number;
      trace_span_count: number;
      cursor: number;
    };
    return {
      eventCount: Number(row.event_count),
      taskCount: Number(row.task_count),
      traceSpanCount: Number(row.trace_span_count),
      cursor: Number(row.cursor),
    };
  }

  currentTasks(): TaskSnapshot[] {
    return (
      this.#statement(
        "SELECT snapshot FROM tasks ORDER BY updated_at DESC, server_sequence DESC",
      ).all() as TaskRow[]
    ).map((row) => JSON.parse(row.snapshot) as TaskSnapshot);
  }

  cursor(): number {
    const row = this.#statement(
      "SELECT COALESCE(MAX(sequence), 0) AS sequence FROM task_events",
    ).get() as { sequence: number };
    return Number(row.sequence);
  }

  #eventFromRow(row: EventRow): ServerEvent {
    return {
      sequence: Number(row.sequence),
      deviceId: row.device_id,
      localSequence: Number(row.local_sequence),
      occurredAt: row.occurred_at,
      trace: {
        traceId: row.trace_id,
        spanId: row.span_id,
        ...(row.parent_span_id ? { parentSpanId: row.parent_span_id } : {}),
      },
      task: JSON.parse(row.snapshot) as TaskSnapshot,
    };
  }
}
