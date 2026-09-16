// Loopback-only acceptance relay. Sends only user-entered test messages to the supplied existing Desktop thread.
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { createApp } from '../../apps/server/src/app.js';
import { Monitor } from '../../apps/desktop/src/monitor.js';
const threadId = process.argv[2];
if (!threadId) throw new Error('Supply an existing Desktop thread ID designated for message acceptance');
const directory = await mkdtemp(join(tmpdir(), 'ca-desktop-message-'));
const token = 'synthetic-acceptance-token';
const server = await createApp({ databasePath: join(directory, 'state.sqlite'), accessToken: token, logger: false });
const monitor = await Monitor.create({ stateDirectory: join(directory, 'monitor'), apiUrl: 'http://127.0.0.1:33241', token, deviceId: 'acceptance', onTasks() {} });
const results: Array<{ requestId: string; status: string; elapsedMs: number }> = [];
let mode = 'real';
server.app.get('/acceptance/results', async () => results);
server.app.post('/acceptance/mode', async request => { mode = (request.body as { mode: string }).mode; return { mode }; });
server.app.post('/acceptance/disconnect', async () => { for (const peer of server.app.websocketServer.clients) peer.close(); return { closed: true }; });
await server.app.listen({ host: '127.0.0.1', port: 33241 });
const now = new Date().toISOString();
await server.app.inject({ method: 'POST', url: '/codex-assistant/api/v3/events', headers: { authorization: `Bearer ${token}` }, payload: {
  protocolVersion: 'codex-assistant.v3', deviceId: 'acceptance', localSequence: 1, occurredAt: now,
  trace: { traceId: '0123456789abcdef0123456789abcdef', spanId: '0123456789abcdef' },
  task: { id: threadId, title: 'Desktop 消息验收', status: 'running', runtimeStatus: 'active', activeFlags: [], freshness: 'fresh', source: 'thread', plan: [], updatedAt: now, changedAt: now },
} });
const ws = new WebSocket('ws://127.0.0.1:33241/codex-assistant/api/v3/stream');
const send = (value: unknown) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(value)); };
ws.on('open', () => send({ type: 'auth', protocolVersion: 'codex-assistant.v3', token }));
ws.on('message', async raw => {
  const message = JSON.parse(String(raw));
  if (message.type === 'authenticated') {
    send({ type: 'subscribe', protocolVersion: 'codex-assistant.v3', after: 0 }); send({ type: 'role', protocolVersion: 'codex-assistant.v3', role: 'desktop' });
  }
  if (message.type === 'detail') send({ type: 'detail', protocolVersion: 'codex-assistant.v3', requestId: message.requestId, threadId, turns: [] });
  if (message.type !== 'send') return;
  const start = performance.now(); let status = 'failed'; let error: string | undefined;
  try {
    if (message.threadId !== threadId) throw new Error('验收目标不匹配');
    if (mode === 'reject') throw new Error('验收用拒绝：消息未发送，草稿保留');
    if (mode === 'delayed-receipt') await new Promise(resolve => setTimeout(resolve, 5000));
    if (mode !== 'delayed-receipt') await monitor.sendMessage(threadId, message.text);
    status = 'started';
  } catch (e) { error = e instanceof Error ? e.message : '发送未确认'; }
  results.push({ requestId: message.requestId, status, elapsedMs: Math.round(performance.now() - start) });
  send({ type: 'result', protocolVersion: 'codex-assistant.v3', requestId: message.requestId, threadId, status, ...(error ? { error } : {}) });
  await mkdir('artifacts/acceptance-2026-09-13', { recursive: true });
  await writeFile('artifacts/acceptance/android-desktop-results.json', JSON.stringify(results, null, 2) + '\n');
});
console.log('Loopback acceptance ready on 127.0.0.1:33241; real Desktop sends enabled');
process.on('SIGINT', async () => { await monitor.stop(); ws.terminate(); await server.close(); await rm(directory, { recursive: true, force: true }); process.exit(); });
