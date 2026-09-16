import { randomBytes } from "node:crypto";
import { appendFile, mkdir, stat, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import {
  safeTraceSpan,
  type TraceContext,
  type TraceSpan,
} from "@codex-assistant/protocol";

function id(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

export function newTraceContext(): TraceContext {
  return { traceId: id(16), spanId: id(8) };
}
export function childTrace(parent: TraceContext): TraceContext {
  return {
    traceId: parent.traceId,
    spanId: id(8),
    parentSpanId: parent.spanId,
  };
}
export function traceparent(context: TraceContext): string {
  return `00-${context.traceId}-${context.spanId}-01`;
}

/** 本地 trace 日志采用 JSONL，方便故障现场导出，也绝不写入命令、路径和模型输出。 */
export class TraceLogger {
  #pending: string[] = [];
  #writing?: Promise<void>;
  #dropped = 0;
  readonly #path: string;
  constructor(path: string) {
    this.#path = path;
  }
  get dropped(): number {
    return this.#dropped;
  }
  record(span: TraceSpan): void {
    this.#pending.push(`${JSON.stringify(safeTraceSpan(span))}\n`);
    if (this.#pending.length > 256) {
      this.#pending.shift();
      this.#dropped++;
    }
    // 只保留一个写入任务，避免每个 span 的 Promise 链无限积压。
    this.#startWriter();
  }
  #startWriter(): void {
    if (this.#writing || !this.#pending.length) return;
    this.#writing = this.#drain().finally(() => {
      this.#writing = undefined;
      // drain 完成至 finally 之间仍可能收到新记录，必须接续写入。
      this.#startWriter();
    });
  }
  async #drain(): Promise<void> {
    while (this.#pending.length) {
      const batch = this.#pending.splice(0, 64);
      try {
        await mkdir(dirname(this.#path), { recursive: true });
        const size = await stat(this.#path).then(
          (value) => value.size,
          (error) => {
            if (error.code === "ENOENT") return 0;
            throw error;
          },
        );
        const text = batch.join("");
        // 最多当前文件和上一份文件，各 5 MiB；只轮转诊断，不接触业务 outbox。
        if (size + Buffer.byteLength(text) > 5 * 1024 * 1024) {
          await rm(`${this.#path}.1`, { force: true });
          await rename(this.#path, `${this.#path}.1`);
        }
        await appendFile(this.#path, text, { encoding: "utf8", mode: 0o600 });
      } catch {
        this.#dropped += batch.length;
      }
    }
  }
  async flush(): Promise<void> {
    while (this.#writing) await this.#writing;
  }
}
