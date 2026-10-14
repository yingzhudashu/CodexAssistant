import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { cpus, release, tmpdir, totalmem } from "node:os";
import { join } from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { createApp } from "../apps/server/src/app.ts";

const token = "codex-assistant-performance-token";
const directory = await mkdtemp(join(tmpdir(), "codex-assistant-perf-"));
let server;
const loop = monitorEventLoopDelay({ resolution: 10 });
try {
  server = await createApp({
    databasePath: join(directory, "state.sqlite"),
    accessToken: token,
    logger: false,
  });
  // 服务初始化会加载 SQLite、Fastify 和 Trace provider；把它排除在工作负载基线外，
  // 才能观察请求本身的资源变化，而不是把冷启动成本误算成业务泄漏。
  globalThis.gc?.();
  loop.enable();
  const cpuStart = process.cpuUsage();
  const measuredAt = performance.now();
  const rssStart = process.memoryUsage().rss;
  const task = {
    id: "perf-thread",
    title: "性能基准",
    status: "running",
    runtimeStatus: "active",
    activeFlags: [],
    freshness: "fresh",
    source: "thread",
    plan: [],
    updatedAt: new Date().toISOString(),
    changedAt: new Date().toISOString(),
  };
  const latencies = [];
  const started = performance.now();
  for (let index = 1; index <= 1000; index += 1) {
    const requestStarted = performance.now();
    const response = await server.app.inject({
      method: "POST",
      url: "/codex-assistant/api/v3/events",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        protocolVersion: "codex-assistant.v3",
        deviceId: "perf-device",
        localSequence: index,
        occurredAt: new Date().toISOString(),
        trace: {
          traceId: "0123456789abcdef0123456789abcdef",
          spanId: index.toString(16).padStart(16, "0"),
        },
        task: {
          ...task,
          updatedAt: new Date(Date.now() + index).toISOString(),
          changedAt: new Date(Date.now() + index).toISOString(),
        },
      },
    });
    // 错误响应不能被当成更快的正常 ingest 混入测量结果。
    if (response.statusCode !== 200 || response.json().sequence !== index)
      throw new Error("PERF_INGEST_FAILED");
    latencies.push(performance.now() - requestStarted);
  }
  const elapsedMs = performance.now() - started;
  const snapshotStarted = performance.now();
  const snapshot = await server.app.inject({
    method: "GET",
    url: "/codex-assistant/api/v3/tasks",
    headers: { authorization: `Bearer ${token}` },
  });
  const snapshotMs = performance.now() - snapshotStarted;
  if (
    snapshot.statusCode !== 200 ||
    snapshot.json().cursor !== 1000 ||
    snapshot.json().tasks.length !== 1
  )
    throw new Error("PERF_SNAPSHOT_FAILED");
  latencies.sort((left, right) => left - right);
  const percentile = (value) =>
    latencies[
      Math.min(latencies.length - 1, Math.ceil(latencies.length * value) - 1)
    ];
  const baseline = {
    events: 1000,
    ingestTotalMs: elapsedMs,
    ingestP50Ms: percentile(0.5),
    ingestP95Ms: percentile(0.95),
    tasksQueryMs: snapshotMs,
  };
  // 独立任务和并发请求采用第二阶段，保留单任务结果，避免改变负载后虚构优化倍数。
  const concurrentLatencies = [];
  for (let offset = 0; offset < 1000; offset += 20) {
    await Promise.all(
      Array.from({ length: 20 }, async (_, worker) => {
        const index = offset + worker + 1001;
        const start = performance.now();
        const result = await server.app.inject({
          method: "POST",
          url: "/codex-assistant/api/v3/events",
          headers: { authorization: `Bearer ${token}` },
          payload: {
            protocolVersion: "codex-assistant.v3",
            deviceId: "perf-device",
            localSequence: index,
            occurredAt: task.updatedAt,
            trace: {
              traceId: "0123456789abcdef0123456789abcdef",
              spanId: index.toString(16).padStart(16, "0"),
            },
            task: { ...task, id: `task-${index}` },
          },
        });
        if (
          result.statusCode !== 200 ||
          !result.json().accepted ||
          result.json().duplicate
        )
          throw new Error("PERF_CONCURRENT_FAILED");
        concurrentLatencies.push(performance.now() - start);
      }),
    );
    await delay(0); // 允许真实定时器和 Trace 批次执行，不能只测一个永不让出的微任务循环。
  }
  const queries = [];
  for (let index = 0; index < 100; index++) {
    const start = performance.now();
    const result = await server.app.inject({
      method: "GET",
      url: "/codex-assistant/api/v3/tasks",
      headers: { authorization: `Bearer ${token}` },
    });
    queries.push(performance.now() - start);
    if (
      result.statusCode !== 200 ||
      result.json().cursor !== 2000 ||
      result.json().tasks.length !== 1001
    )
      throw new Error("PERF_MULTITASK_SNAPSHOT_FAILED");
    // inject 返回体包含完整快照；不让测试循环持有上一轮解析对象，避免把压测工具的
    // 暂态分配误报为服务端常驻内存。峰值仍由 rssBeforeGcBytes 单独记录。
    if (index % 10 === 9) {
      globalThis.gc?.();
      await delay(0);
    }
  }
  const p95 = (values) =>
    values.sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  const concurrentIngestP95Ms = p95(concurrentLatencies);
  const queryP95Ms = p95(queries);
  const cpu = process.cpuUsage(cpuStart);
  const rssBeforeGc = process.memoryUsage().rss;
  const measuredDurationMs = performance.now() - measuredAt;
  globalThis.gc?.();
  await delay(0);
  const eventLoopP95Ms = loop.percentile(95) / 1e6;
  const cpuPercentOneCore = (cpu.user + cpu.system) / 10 / measuredDurationMs;
  const rssDeltaBytes = process.memoryUsage().rss - rssStart;
  const budgets = {
    ingestP95Ms: 50,
    queryP95Ms: 100,
    rssDeltaBytes: 128 * 1024 * 1024,
    cpuPercentOneCore: 80,
    eventLoopP95Ms: 50,
  };
  const budgetExceeded =
    baseline.ingestP95Ms > budgets.ingestP95Ms ||
    concurrentIngestP95Ms > budgets.ingestP95Ms ||
    queryP95Ms > budgets.queryP95Ms ||
    rssDeltaBytes > budgets.rssDeltaBytes ||
    cpuPercentOneCore > budgets.cpuPercentOneCore ||
    eventLoopP95Ms > budgets.eventLoopP95Ms;
  const result = {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    machine: {
      osRelease: release(),
      cpuModel: cpus()[0]?.model ?? "unknown",
      logicalCpuCount: cpus().length,
      totalMemoryBytes: totalmem(),
    },
    baseline,
    multiTask: {
      tasks: 1001,
      concurrency: 20,
      events: 1000,
      ingestP95Ms: concurrentIngestP95Ms,
      querySamples: queries.length,
      queryP95Ms,
    },
    cpuMs: (cpu.user + cpu.system) / 1000,
    measuredDurationMs,
    cpuPercentOneCore,
    rssBytes: process.memoryUsage().rss,
    rssBeforeGcBytes: rssBeforeGc,
    rssDeltaBytes,
    eventLoopP95Ms,
    budgets,
    passed: !budgetExceeded,
  };
  const reportDirectory = join(process.cwd(), "artifacts", "acceptance");
  await mkdir(reportDirectory, { recursive: true });
  await writeFile(
    join(reportDirectory, "performance.json"),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify(result));
  if (budgetExceeded) throw new Error("PERF_RESOURCE_BUDGET_EXCEEDED");
} finally {
  loop.disable();
  // 只删除本次 mkdtemp 创建的目录；正常退出和验证失败都不遗留临时数据库。
  await server?.close();
  await rm(directory, { recursive: true, force: true });
}
