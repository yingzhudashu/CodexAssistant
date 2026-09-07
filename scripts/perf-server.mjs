import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createApp } from '../apps/server/src/app.ts';

const token = 'codex-assistant-performance-token';
const directory = await mkdtemp(join(tmpdir(), 'codex-assistant-perf-'));
const server = await createApp({ databasePath: join(directory, 'state.sqlite'), accessToken: token, logger: false });
const task = { id: 'perf-thread', title: '性能基准', status: 'active', runtimeStatus: 'active', activeFlags: [], freshness: 'fresh', source: 'thread', plan: [], updatedAt: new Date().toISOString(), changedAt: new Date().toISOString() };
const latencies = [];
const started = performance.now();
for (let index = 1; index <= 1000; index += 1) {
  const requestStarted = performance.now();
  await server.app.inject({ method: 'POST', url: '/codex-assistant/api/v2/events', headers: { authorization: `Bearer ${token}` }, payload: { protocolVersion: 'codex-assistant.v2', deviceId: 'perf-device', localSequence: index, occurredAt: new Date().toISOString(), trace: { traceId: '0123456789abcdef0123456789abcdef', spanId: index.toString(16).padStart(16, '0') }, task: { ...task, updatedAt: new Date(Date.now() + index).toISOString(), changedAt: new Date(Date.now() + index).toISOString() } } });
  latencies.push(performance.now() - requestStarted);
}
const elapsedMs = performance.now() - started;
const snapshotStarted = performance.now();
await server.app.inject({ method: 'GET', url: '/codex-assistant/api/v2/tasks', headers: { authorization: `Bearer ${token}` } });
const snapshotMs = performance.now() - snapshotStarted;
latencies.sort((left, right) => left - right);
const percentile = (value) => latencies[Math.min(latencies.length - 1, Math.ceil(latencies.length * value) - 1)];
console.log(JSON.stringify({ events: 1000, ingestTotalMs: Math.round(elapsedMs), ingestP50Ms: Math.round(percentile(0.5)), ingestP95Ms: Math.round(percentile(0.95)), tasksQueryMs: Math.round(snapshotMs), rssBytes: process.memoryUsage().rss }));
await server.close();
