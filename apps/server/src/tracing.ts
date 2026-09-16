import { ROOT_CONTEXT, trace, TraceFlags, type Span } from "@opentelemetry/api";
import {
  ExportResultCode,
  W3CTraceContextPropagator,
  type ExportResult,
} from "@opentelemetry/core";
import {
  BatchSpanProcessor,
  BasicTracerProvider,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import {
  safeTraceSpan,
  type TraceContext,
  type TraceSpan,
} from "@codex-assistant/protocol";
import type { TaskDatabase } from "./database.js";

/** 一个服务实例拥有自己的 provider，避免测试、多实例和关闭时相互污染全局上下文。 */
export class ServerTracing {
  #failedExports = 0;
  readonly #provider: BasicTracerProvider;
  readonly #propagator = new W3CTraceContextPropagator();

  constructor(database: TaskDatabase) {
    const exporter: SpanExporter = {
      export: (
        spans: ReadableSpan[],
        callback: (result: ExportResult) => void,
      ) => {
        try {
          // 每批一个事务；只写一次，不在请求路径同步补写同一 span。
          database.recordSpans(
            spans.map((span) => {
              const milliseconds = (time: [number, number]) =>
                time[0] * 1000 + time[1] / 1_000_000;
              return safeTraceSpan({
                traceId: span.spanContext().traceId,
                spanId: span.spanContext().spanId,
                ...(span.parentSpanContext
                  ? { parentSpanId: span.parentSpanContext.spanId }
                  : {}),
                name: span.name,
                startedAt: new Date(milliseconds(span.startTime)).toISOString(),
                endedAt: new Date(milliseconds(span.endTime)).toISOString(),
                attributes: Object.fromEntries(
                  Object.entries(span.attributes).map(([key, value]) => [
                    key,
                    String(value),
                  ]),
                ),
              });
            }),
          );
          callback({ code: ExportResultCode.SUCCESS });
        } catch {
          this.#failedExports++;
          callback({ code: ExportResultCode.FAILED });
        }
      },
      shutdown: async () => {},
    };
    this.#provider = new BasicTracerProvider({
      spanProcessors: [
        new BatchSpanProcessor(exporter, {
          maxQueueSize: 2048,
          maxExportBatchSize: 256,
          scheduledDelayMillis: 250,
        }),
      ],
    });
  }

  get failedExports(): number {
    return this.#failedExports;
  }

  http(method: string, traceparent?: string): Span {
    const parent = this.#propagator.extract(
      ROOT_CONTEXT,
      { traceparent },
      {
        keys: (carrier) => Object.keys(carrier),
        get: (carrier, key) => carrier[key as "traceparent"],
      },
    );
    return this.#provider
      .getTracer("codex-assistant")
      .startSpan(`http.${method.toLowerCase()}`, {}, parent);
  }

  start(
    name: string,
    parent: TraceContext,
    attributes: Record<string, string> = {},
  ): Span {
    return this.#provider.getTracer("codex-assistant").startSpan(
      name,
      { attributes },
      trace.setSpanContext(ROOT_CONTEXT, {
        traceId: parent.traceId,
        spanId: parent.spanId,
        traceFlags: TraceFlags.SAMPLED,
      }),
    );
  }

  /** 查询是一致性边界，等待已有批次落盘；业务请求无需等待 exporter。 */
  async flush(): Promise<void> {
    await this.#provider.forceFlush().catch(() => undefined);
  }
  async close(): Promise<void> {
    await this.#provider.shutdown().catch(() => undefined);
  }
}
