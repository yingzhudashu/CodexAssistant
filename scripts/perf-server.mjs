import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createApp } from '../apps/server/src/app.ts';

const token = 'codex-assistant-performance-token';
const directory = await mkdtemp(join(tmpdir(), 'codex-assistant-perf-'));
let server;
try {
  server = await createApp({ databasePath: join(directory, 'state.sqlite'), accessToken: token, logger: false });
  const task = { id: 'perf-thread', title: '性能基准', status: 'active', runtimeStatus: 'active', activeFlags: [], freshness: 'fresh', source: 'thread', plan: [], updatedAt: new Date().toISOString(), changedAt: new Date().toISOString() };
  const latencies = [];
  const started = performance.now();
  for (let index = 1; index <= 1000; index += 1) {
    const requestStarted = performance.now();
    const response = await server.app.inject({ method: 'POST', url: '/codex-assistant/api/v2/events', headers: { authorization: `Bearer ${token}` }, payload: { protocolVersion: 'codex-assistant.v2', deviceId: 'perf-device', localSequence: index, occurredAt: new Date().toISOString(), trace: { traceId: '0123456789abcdef0123456789abcdef', spanId: index.toString(16).padStart(16, '0') }, task: { ...task, updatedAt: new Date(Date.now() + index).toISOString(), changedAt: new Date(Date.now() + index).toISOString() } } });
    // 错误响应不能被当成更快的正常 ingest 混入测量结果。
    if (response.statusCode !== 200 || response.json().sequence !== index) throw new Error('PERF_INGEST_FAILED');
    latencies.push(performance.now() - requestStarted);
  }
  const elapsedMs = performance.now() - started;
  const snapshotStarted = performance.now();
  const snapshot = await server.app.inject({ method: 'GET', url: '/codex-assistant/api/v2/tasks', headers: { authorization: `Bearer ${token}` } });
  const snapshotMs = performance.now() - snapshotStarted;
  if (snapshot.statusCode !== 200 || snapshot.json().cursor !== 1000 || snapshot.json().tasks.length !== 1) throw new Error('PERF_SNAPSHOT_FAILED');
  latencies.sort((left, right) => left - right);
  const percentile = (value) => latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * value) - 1)];
  console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, events: 1000, ingestTotalMs: Math.round(elapsedMs), ingestP50Ms: Math.round(percentile(0.5)), ingestP95Ms: Math.round(percentile(0.95)), tasksQueryMs: Math.round(snapshotMs), rssBytes: process.memoryUsage().rss }));
} finally {
  // 只删除本次 mkdtemp 创建的目录；正常退出和验证失败都不遗留临时数据库。
  await server?.close();
  await rm(directory, { recursive: true, force: true });
}
