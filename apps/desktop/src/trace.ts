import { randomBytes } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { TraceContext, TraceSpan } from "@codex-assistant/protocol";

function id(bytes: number): string { return randomBytes(bytes).toString("hex"); }

export function newTraceContext(): TraceContext { return { traceId: id(16), spanId: id(8) }; }
export function childTrace(parent: TraceContext): TraceContext { return { traceId: parent.traceId, spanId: id(8), parentSpanId: parent.spanId }; }
export function traceparent(context: TraceContext): string { return `00-${context.traceId}-${context.spanId}-01`; }

/** 本地 trace 日志采用 JSONL，方便故障现场导出，也绝不写入命令、路径和模型输出。 */
export class TraceLogger {
  #queue = Promise.resolve();
  #path: string;
  constructor(path: string) { this.#path = path; }
  record(span: TraceSpan): void {
    this.#queue = this.#queue.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      await appendFile(this.#path, `${JSON.stringify(span)}\n`, { encoding: "utf8", mode: 0o600 });
    }).catch(() => undefined);
  }
  async flush(): Promise<void> { await this.#queue; }
}
