import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../apps/server/src/app.ts';

const token = 'codex-assistant-performance-token';
const directory = await mkdtemp(join(tmpdir(), 'codex-assistant-perf-'));
let server;
const loop = monitorEventLoopDelay({ resolution: 10 });
loop.enable();
const cpuStart = process.cpuUsage();
const measuredAt = performance.now();
const rssStart = process.memoryUsage().rss;
try {
  server = await createApp({ databasePath: join(directory, 'state.sqlite'), accessToken: token, logger: false });
  const task = { id: 'perf-thread', title: '性能基准', status: 'running', runtimeStatus: 'active', activeFlags: [], freshness: 'fresh', source: 'thread', plan: [], updatedAt: new Date().toISOString(), changedAt: new Date().toISOString() };
  const latencies = [];
  const started = performance.now();
  for (let index = 1; index <= 1000; index += 1) {
    const requestStarted = performance.now();
    const response = await server.app.inject({ method: 'POST', url: '/codex-assistant/api/v3/events', headers: { authorization: `Bearer ${token}` }, payload: { protocolVersion: 'codex-assistant.v3', deviceId: 'perf-device', localSequence: index, occurredAt: new Date().toISOString(), trace: { traceId: '0123456789abcdef0123456789abcdef', spanId: index.toString(16).padStart(16, '0') }, task: { ...task, updatedAt: new Date(Date.now() + index).toISOString(), changedAt: new Date(Date.now() + index).toISOString() } } });
    // 错误响应不能被当成更快的正常 ingest 混入测量结果。
    if (response.statusCode !== 200 || response.json().sequence !== index) throw new Error('PERF_INGEST_FAILED');
    latencies.push(performance.now() - requestStarted);
  }
  const elapsedMs = performance.now() - started;
  const snapshotStarted = performance.now();
  const snapshot = await server.app.inject({ method: 'GET', url: '/codex-assistant/api/v3/tasks', headers: { authorization: `Bearer ${token}` } });
  const snapshotMs = performance.now() - snapshotStarted;
  if (snapshot.statusCode !== 200 || snapshot.json().cursor !== 1000 || snapshot.json().tasks.length !== 1) throw new Error('PERF_SNAPSHOT_FAILED');
  latencies.sort((left, right) => left - right);
  const percentile = (value) => latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * value) - 1)];
  const baseline = { events: 1000, ingestTotalMs: elapsedMs, ingestP50Ms: percentile(0.5), ingestP95Ms: percentile(0.95), tasksQueryMs: snapshotMs };
  // 独立任务和并发请求采用第二阶段，保留单任务结果，避免改变负载后虚构优化倍数。
  const concurrentLatencies = [];
  for (let offset = 0; offset < 1000; offset += 20) {
    await Promise.all(Array.from({ length: 20 }, async (_, worker) => {
      const index = offset + worker + 1001;
      const start = performance.now();
      const result = await server.app.inject({ method: 'POST', url: '/codex-assistant/api/v3/events', headers: { authorization: `Bearer ${token}` }, payload: { protocolVersion: 'codex-assistant.v3', deviceId: 'perf-device', localSequence: index, occurredAt: task.updatedAt, trace: { traceId: '0123456789abcdef0123456789abcdef', spanId: index.toString(16).padStart(16, '0') }, task: { ...task, id: `task-${index}` } } });
      if (result.statusCode !== 200 || !result.json().accepted || result.json().duplicate) throw new Error('PERF_CONCURRENT_FAILED');
      concurrentLatencies.push(performance.now() - start);
    }));
    await delay(0); // 允许真实定时器和 Trace 批次执行，不能只测一个永不让出的微任务循环。
  }
  const queries = [];
  for (let index = 0; index < 100; index++) {
    const start = performance.now();
    const result = await server.app.inject({ method: 'GET', url: '/codex-assistant/api/v3/tasks', headers: { authorization: `Bearer ${token}` } });
    queries.push(performance.now() - start);
    if (result.statusCode !== 200 || result.json().cursor !== 2000 || result.json().tasks.length !== 1001) throw new Error('PERF_MULTITASK_SNAPSHOT_FAILED');
  }
  const p95 = values => values.sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1];
  const cpu = process.cpuUsage(cpuStart);
  const result = {
    node: process.version, platform: process.platform, arch: process.arch, baseline,
    multiTask: { tasks: 1001, concurrency: 20, events: 1000, ingestP95Ms: p95(concurrentLatencies), querySamples: queries.length, queryP95Ms: p95(queries) },
    cpuMs: (cpu.user + cpu.system) / 1000, cpuPercentOneCore: (cpu.user + cpu.system) / 10 / (performance.now() - measuredAt),
    rssBytes: process.memoryUsage().rss, rssDeltaBytes: process.memoryUsage().rss - rssStart,
    eventLoopP95Ms: loop.percentile(95) / 1e6,
  };
  console.log(JSON.stringify(result));
  if (baseline.ingestP95Ms > 50 || result.multiTask.ingestP95Ms > 50 || result.multiTask.queryP95Ms > 100) throw new Error('PERF_LATENCY_BUDGET_EXCEEDED');
} finally {
  loop.disable();
  // 只删除本次 mkdtemp 创建的目录；正常退出和验证失败都不遗留临时数据库。
  await server?.close();
  await rm(directory, { recursive: true, force: true });
}
