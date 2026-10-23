import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { basename } from "node:path";
import {
  TraceSpanSchema,
  parseStrict,
  safeTraceSpan,
} from "@codex-assistant/protocol";

// 离线只读分析；输出统计而非原始 span、任务 ID、路径或错误正文。
// 直方图空间固定，关联索引最多十万项，长日志不会无限占用内存。
const limits = [1, 5, 10, 50, 100, 500, 1000, 5000, 15000, 60000, Infinity];
const files = process.argv.slice(2);
if (!files.length) {
  console.error(
    "Usage: node scripts/analyze-trace.mjs <trace.jsonl> [trace.jsonl.1 ...]",
  );
  process.exit(2);
}
const report = {
  files: [],
  valid: 0,
  invalid: 0,
  duplicateSpans: 0,
  unresolvedParents: 0,
  correlationTruncated: false,
  byName: {},
  counters: {},
};
const spans = new Map();
const counters = new Set([
  "traceDropped",
  "lifecycleReadFailures",
  "lifecycleCatchups",
  "lifecyclePathMissing",
  "lifecycleEvidenceMissing",
  "detailFailures",
  "threadFailures",
  "goalFailures",
  "turnFailures",
  "itemFailures",
]);
for (const path of files) {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  let bytes = 0,
    rows = 0;
  stream.on("data", (chunk) => {
    hash.update(chunk);
    bytes += chunk.length;
  });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    rows++;
    let value;
    try {
      value =
        line.length <= 65536
          ? parseStrict(TraceSpanSchema, JSON.parse(line))
          : undefined;
    } catch {}
    if (!value) {
      report.invalid++;
      continue;
    }
    const span = safeTraceSpan(value);
    const duration = Date.parse(span.endedAt) - Date.parse(span.startedAt);
    if (!Number.isFinite(duration) || duration < 0) {
      report.invalid++;
      continue;
    }
    report.valid++;
    const row = (report.byName[span.name] ??= {
      count: 0,
      errors: 0,
      missingOutcome: 0,
      totalMs: 0,
      maxMs: 0,
      latencyBuckets: limits.map(() => 0),
    });
    row.count++;
    row.totalMs += duration;
    row.maxMs = Math.max(row.maxMs, duration);
    if (span.attributes?.error || span.attributes?.outcome === "error")
      row.errors++;
    if (span.name.startsWith("app_server.") && !span.attributes?.outcome)
      row.missingOutcome++;
    row.latencyBuckets[limits.findIndex((limit) => duration <= limit)]++;
    for (const [key, value] of Object.entries(span.attributes ?? {}))
      if (counters.has(key))
        report.counters[key] = (report.counters[key] ?? 0) + Number(value);
    const key = `${span.traceId}:${span.spanId}`;
    if (spans.has(key)) report.duplicateSpans++;
    else if (spans.size < 100000)
      spans.set(
        key,
        span.parentSpanId ? `${span.traceId}:${span.parentSpanId}` : null,
      );
    else report.correlationTruncated = true;
  }
  report.files.push({
    name: basename(path),
    bytes,
    rows,
    sha256: hash.digest("hex"),
  });
}
for (const parent of spans.values())
  if (parent && !spans.has(parent)) report.unresolvedParents++;
for (const row of Object.values(report.byName)) {
  row.meanMs = row.totalMs / row.count;
  delete row.totalMs;
}
console.log(
  JSON.stringify(
    {
      ...report,
      latencyBucketUpperBoundsMs: limits.map((value) =>
        Number.isFinite(value) ? value : "infinity",
      ),
      note: "父节点缺失可能来自轮转、延迟上传或采样；RPC 缺少 outcome 不能推断成功。计数按输入记录求和，重叠日志会重复统计。",
    },
    null,
    2,
  ),
);
