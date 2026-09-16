import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { createApp } from '../../apps/server/src/app.js';
import { PROTOCOL_VERSION } from '@codex-assistant/protocol';

// Real HTTP + WebSocket, 1000 distinct tasks, 30 minutes after seeding.
const directory = await mkdtemp(join(tmpdir(), 'codex-endurance-'));
const token = 'synthetic-endurance-token';
const server = await createApp({ databasePath: join(directory, 'state.sqlite'), accessToken: token, logger: false });
const reportPath = 'artifacts/acceptance/server-endurance.json';
await mkdir('artifacts/acceptance', { recursive: true });
const report = { completed: false, durationMs: 0, events: 0, snapshots: 0, reconnects: 0, tasks: 0, samples: [] as Array<{ elapsedMs: number; rssBytes: number; cpuPercentOneCore: number; ingestP95Ms: number; cursor: number; taskCount: number }>, error: '' };
let peer: WebSocket | undefined;
let cursor = 0;
let sequence = 0;
const states = new Map<string, string>();
const latencies: number[] = [];
const persist = () => writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
try {
  await server.app.listen({ host: '127.0.0.1', port: 0 });
  const address = server.app.server.address();
  if (!address || typeof address === 'string') throw new Error('NO_ADDRESS');
  const base = `http://127.0.0.1:${address.port}/codex-assistant/api/v3`;
  const connect = async () => {
    peer?.terminate();
    const ws = new WebSocket(base.replace('http:', 'ws:') + '/stream'); peer = ws;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SNAPSHOT_TIMEOUT')), 10_000);
      ws.once('error', error => { clearTimeout(timer); reject(error); });
      ws.on('open', () => ws.send(JSON.stringify({ type: 'auth', protocolVersion: PROTOCOL_VERSION, token })));
      ws.on('message', raw => {
        const m = JSON.parse(String(raw));
        if (m.type === 'authenticated') ws.send(JSON.stringify({ type: 'subscribe', protocolVersion: PROTOCOL_VERSION, after: cursor }));
        if (m.type === 'event') { cursor = m.event.sequence; states.set(m.event.task.id, m.event.task.status); report.events++; }
        if (m.type === 'snapshot') {
          cursor = m.cursor; states.clear(); for (const task of m.tasks) states.set(task.id, task.status);
          report.snapshots++; clearTimeout(timer); resolve();
        }
      });
    });
  };
  const ingest = async (index: number) => {
    sequence++;
    const now = new Date().toISOString();
    const status = ['running', 'completed', 'failed', 'needs_action'][sequence % 4];
    const task = { id: `endurance-${index}`, title: `验收任务 ${index}`, status, runtimeStatus: 'idle', activeFlags: [], freshness: 'fresh', source: 'thread', plan: [], updatedAt: now, changedAt: now };
    const start = performance.now();
    const r = await fetch(base + '/events', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, deviceId: 'endurance', localSequence: sequence, occurredAt: now, trace: { traceId: '0123456789abcdef0123456789abcdef', spanId: sequence.toString(16).padStart(16, '0') }, task }), signal: AbortSignal.timeout(10_000) });
    const body = await r.json() as { sequence: number };
    if (!r.ok || body.sequence !== sequence) throw new Error('INGEST_FAILED');
    latencies.push(performance.now() - start);
  };
  await connect();
  for (let i = 0; i < 1000; i++) await ingest(i);
  const started = Date.now(); const cpuStarted = process.cpuUsage();
  latencies.length = 0;
  let nextSample = 60_000;
  let nextReconnect = 5 * 60_000;
  while (Date.now() - started < 30 * 60_000) {
    await ingest(sequence % 1000);
    const elapsed = Date.now() - started;
    if (elapsed >= nextReconnect) { await connect(); report.reconnects++; nextReconnect += 5 * 60_000; }
    if (elapsed >= nextSample) {
      const cpu = process.cpuUsage(cpuStarted);
      const sorted = latencies.splice(0).sort((a,b) => a-b);
      report.durationMs = elapsed; report.tasks = states.size;
      report.samples.push({ elapsedMs: elapsed, rssBytes: process.memoryUsage().rss, cpuPercentOneCore: ((cpu.user + cpu.system) / 1000) / Math.max(1,elapsed) * 100, ingestP95Ms: sorted[Math.floor(sorted.length * .95)], cursor, taskCount: states.size });
      await persist(); nextSample += 60_000;
    }
    if (peer?.readyState !== WebSocket.OPEN) throw new Error('SUBSCRIBER_DISCONNECTED');
    await delay(500);
  }
  await connect();
  report.durationMs = Date.now() - started;
  report.tasks = states.size;
  if (cursor !== sequence || states.size !== 1000) throw new Error('FINAL_SNAPSHOT_MISMATCH');
  const stable = report.samples.slice(1);
  const rssGrowth = stable.at(-1)!.rssBytes - stable[0].rssBytes;
  if (rssGrowth > 50 * 1024 * 1024) throw new Error('RSS_GROWTH_EXCEEDED_50_MIB');
  report.completed = true;
} catch (error) { report.error = error instanceof Error ? error.message : 'ENDURANCE_FAILED'; process.exitCode = 1; }
finally { peer?.terminate(); await server.close(); await rm(directory, { recursive: true, force: true }); await persist(); }
console.log(JSON.stringify(report));
